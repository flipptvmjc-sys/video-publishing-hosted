// BCB AI layer — Beyond Copper Branding's connection to Sophia.
//
// ARCHITECTURE (per ~/workspace/research_notes/sophia-integration-plan-20261117/report.md §0–§2,
// and ~/workspace/research_notes/bcb-research-rea-20261117/report.md):
// - The app NEVER calls a model directly and NEVER calls Muse. The app's AI
//   goes through ONE door: the VPS API wrapper (F1), sophia-foundation
//   v1.0.0, live at https://66.135.7.93:8443. Batch jobs go through
//   POST /v1/batch (queued, polled) — the wrapper's one-at-a-time +
//   300 MiB gating applies to everything. There is NO direct `claude -p`
//   runner any more (see ~/workspace/sophia-ai-build/bcb-batch/README.md).
// - MCP tools (F2) the BCB agent exposes are defined here as data
//   (MCP_TOOLS); the app side of each tool is the dispatch receiver
//   POST /api/ai/mcp/:tool (see server.js).
// - TLS (defect (a), fixed 2026-11-17 wave 1A): the wrapper's cert is
//   self-signed. This client pins its SHA-256 fingerprint AND requires
//   the CA PEM (SOPHIA_WRAPPER_CA_PEM) — proven live in the Hub
//   verification: WITHOUT the PEM the call fails
//   DEPTH_ZERO_SELF_SIGNED_CERT; WITH it, calls proceed. Transport is
//   node:https with a custom agent; `rejectUnauthorized` stays true.
//   NODE_TLS_REJECT_UNAUTHORIZED is NEVER set anywhere in this file.
//   SOPHIA_WRAPPER_CA_PEM is a path to the PEM file (on the VPS:
//   /opt/sophia/foundation/tls/cert.pem) or the PEM text itself (on
//   Render, where there is no cert file — paste the PEM as the env value).
// - Env:
//     SOPHIA_WRAPPER_URL       base URL of the deployed wrapper, https only
//                              (e.g. https://66.135.7.93:8443)
//     SOPHIA_WRAPPER_TOKEN     the app's Bearer token (bcb token from the
//                              wrapper's tokens.json — set at deploy time)
//     SOPHIA_WRAPPER_REFRESH_TOKEN  reserved name for the portable
//                              token's rotating refresh token (step 3,
//                              lib/portable-tokens.js). NOT consumed by
//                              this client yet: the wrapper has no refresh
//                              endpoint until its verification-side change
//                              lands (docs/token-portability.md). Until
//                              then the access token above is the live
//                              credential and refresh happens by
//                              re-issuing, not by rotation.
//     SOPHIA_WRAPPER_CA_PEM    CA PEM path or PEM text (required)
//     SOPHIA_WRAPPER_FINGERPRINT  override for the pinned fingerprint
//                              (default is the deployed cert's fingerprint)
//     BCB_AI_TOKEN             shared secret the batch ingest path uses:
//                              POST /api/ai/jobs/:id/result (ingest only)
//     SOPHIA_SERVICE_TOKEN     shared secret the MCP dispatch receiver
//                              accepts (X-Sophia-Token). MUST equal the
//                              wrapper's service_token in
//                              /opt/sophia/foundation/config.json. This is
//                              a DIFFERENT value from BCB_AI_TOKEN (defect
//                              (g)) — the two secrets are never the same.
//   No token value is ever printed, logged, or written to a file by this
//   module. See docs/batch-pipeline.md for what must be set, where, and
//   by whom.
// - Paid video/image models (F6) are NOT wired here. No Veo/Seedance/Kling
//   keys exist; generation adapters are a separate, NOT APPROVED spend.
// - FIXED (wave 2D, 2026-11-17): the wrapper's batch worker now
//   passes --allowedTools "WebSearch,WebFetch" for task=network_watch
//   (server.py, verified live: job 9dc9d061b05dd597 returned 2
//   web-sourced changes). The network_watch prompt was updated in
//   the same wave to use the tools and cite fetched URLs. The old
//   direct runner's --allowedTools flag is now the wrapper's
//   behaviour for this job type; all other tasks still run with no
//   web tools (least privilege).
const https = require('https');
const fs = require('fs');
const path = require('path');

const WRAPPER_FINGERPRINT_DEFAULT = 'CF:70:A4:15:3F:A6:5D:38:21:24:23:1D:B7:77:55:53:6F:2D:02:27:E8:05:DF:C8:2C:79:F9:56:68:04:D1:27';
const PROMPT_MAX_CHARS = 8000;
// Wrapper timeouts requested (seconds): chat default 120, batch default
// 600 (per FOUNDATION-CONTRACT.md). The CLIENT abort is always strictly
// LONGER than the wrapper timeout requested — CLIENT_TIMEOUT_SLACK_MS
// past it (defect (e)) — so the client never races the wrapper timeout.
const WRAPPER_CHAT_TIMEOUT_S = 120;
const WRAPPER_BATCH_TIMEOUT_S = 600;
const WRAPPER_CHAT_TIMEOUT_MAX_S = 300;
const WRAPPER_BATCH_TIMEOUT_MAX_S = 1800;
const CLIENT_TIMEOUT_SLACK_MS = 30000;
// The batch-submit POST only queues (202 comes back immediately), so its
// own client timeout is short; the job's runtime is bounded by the
// wrapper timeout + the poll loop, not by this HTTP call.
const BATCH_SUBMIT_TIMEOUT_MS = 30000;
const BATCH_POLL_TIMEOUT_MS = 30000;

// Error codes (defect (b) — never collapsed into one silent fallback).
// Every wrapper failure carries a distinct code; 429 also carries
// retryAfterSec from the Retry-After header.
const ERROR_CODES = [
  'not_configured', 'tls_ca_missing', 'tls_mismatch', 'bad_config',
  'unauthorized', 'tier_gated', 'tier_required', 'bad_request', 'not_found',
  'rate_limited', 'agent_not_provisioned', 'gateway_error', 'ram_gated',
  'prompt_too_long', 'timeout', 'network', 'bad_response', 'unknown',
];

class AiUnavailableError extends Error {
  constructor(message, code = 'unknown', retryAfterSec) {
    super(message);
    this.name = 'AiUnavailableError';
    this.code = ERROR_CODES.includes(code) ? code : 'unknown';
    if (retryAfterSec !== undefined && retryAfterSec !== null) this.retryAfterSec = retryAfterSec;
  }
}

const WRAPPER_URL = (process.env.SOPHIA_WRAPPER_URL || '').replace(/\/$/, '');
const WRAPPER_TOKEN = process.env.SOPHIA_WRAPPER_TOKEN || '';
const WRAPPER_FINGERPRINT = (process.env.SOPHIA_WRAPPER_FINGERPRINT || WRAPPER_FINGERPRINT_DEFAULT).replace(/[:\s]/g, '').toUpperCase();
const AI_TOKEN = process.env.BCB_AI_TOKEN || '';
const SERVICE_TOKEN = process.env.SOPHIA_SERVICE_TOKEN || '';

function isWrapperConfigured() {
  // https-only: an http:// URL is NOT a configured wrapper — the pinned
  // TLS transport below cannot speak to it, so say so up front instead
  // of reporting "live-via-wrapper" and failing every call.
  return !!(WRAPPER_URL && WRAPPER_URL.startsWith('https://') && WRAPPER_TOKEN);
}

// --- TLS: CA PEM + fingerprint pin (defect (a)) ---
let _caPem = null;
let _caPemLoaded = false;
function getCaPem() {
  if (_caPemLoaded) {
    if (_caPem) return _caPem;
    throw new AiUnavailableError(
      'Sophia wrapper CA PEM is not set — set SOPHIA_WRAPPER_CA_PEM to the wrapper cert PEM (path to the file, e.g. /opt/sophia/foundation/tls/cert.pem, or the PEM text itself)',
      'tls_ca_missing');
  }
  _caPemLoaded = true;
  const raw = (process.env.SOPHIA_WRAPPER_CA_PEM || '').trim();
  if (!raw) {
    throw new AiUnavailableError(
      'Sophia wrapper CA PEM is not set — set SOPHIA_WRAPPER_CA_PEM to the wrapper cert PEM (path to the file, e.g. /opt/sophia/foundation/tls/cert.pem, or the PEM text itself)',
      'tls_ca_missing');
  }
  if (raw.startsWith('-----BEGIN CERTIFICATE-----')) { _caPem = raw; return _caPem; }
  try {
    _caPem = fs.readFileSync(raw, 'utf8');
  } catch (e) {
    throw new AiUnavailableError(`Sophia wrapper CA PEM could not be read from ${raw}: ${e.message}`, 'tls_ca_missing');
  }
  return _caPem;
}

let _agent = null;
function wrapperAgent() {
  if (_agent) return _agent;
  const ca = getCaPem(); // throws tls_ca_missing before any call is made
  _agent = new https.Agent({
    ca,
    rejectUnauthorized: true, // never disabled — the fingerprint pin below is the second check
    checkServerIdentity: (host, cert) => {
      const fp = String((cert && cert.fingerprint256) || '').replace(/[:\s]/g, '').toUpperCase();
      if (!fp) return new Error('wrapper presented no certificate fingerprint');
      if (fp !== WRAPPER_FINGERPRINT) {
        return new Error(`wrapper certificate fingerprint mismatch (expected ${WRAPPER_FINGERPRINT}, got ${fp})`);
      }
      return undefined; // match — identity verified
    },
  });
  return _agent;
}

// --- HTTP layer: node:https only, never fetch, never verification-off ---
function statusToCode(status, bodyError) {
  if (bodyError === 'tier_required') return 'tier_required';
  if (bodyError === 'tier_gated') return 'tier_gated';
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 402: return 'tier_gated';
    case 404: return 'not_found';
    case 429: return 'rate_limited';
    case 501: return 'agent_not_provisioned';
    case 502: return 'gateway_error';
    case 503: return 'ram_gated';
    default: return 'unknown';
  }
}

function wrapperRequest({ method, path: reqPath, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let agent;
    try { agent = wrapperAgent(); } catch (e) { return reject(e); }
    const data = body !== undefined ? JSON.stringify(body) : null;
    let req;
    try {
      req = https.request(WRAPPER_URL + reqPath, {
        method,
        agent,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${WRAPPER_TOKEN}`,
          ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      });
    } catch (e) {
      return reject(new AiUnavailableError(`Sophia wrapper request could not start: ${e.message}`, 'network'));
    }
    req.on('timeout', () => req.destroy(new Error('__BCB_TIMEOUT__')));
    req.on('error', (e) => {
      if (e && e.message === '__BCB_TIMEOUT__') {
        return reject(new AiUnavailableError(`Sophia wrapper ${method} ${reqPath} timed out after ${timeoutMs}ms`, 'timeout'));
      }
      // TLS failures surface here (fingerprint mismatch, untrusted cert).
      const msg = String((e && e.message) || e);
      if (/fingerprint mismatch|no certificate fingerprint/.test(msg)) {
        return reject(new AiUnavailableError(`Sophia wrapper TLS identity check failed: ${msg}`, 'tls_mismatch'));
      }
      if (/DEPTH_ZERO_SELF_SIGNED_CERT|self-signed certificate|unable to verify/i.test(msg)) {
        return reject(new AiUnavailableError(`Sophia wrapper TLS certificate was not trusted (${msg}). Set SOPHIA_WRAPPER_CA_PEM to the wrapper cert PEM.`, 'tls_mismatch'));
      }
      return reject(new AiUnavailableError(`Sophia wrapper unreachable (${method} ${reqPath}): ${msg}`, 'network'));
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch { /* non-JSON body */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const code = (j && (j.error || j.message)) || text.slice(0, 200) || `HTTP ${res.statusCode}`;
          let retryAfterSec;
          if (res.statusCode === 429) {
            const ra = parseInt(res.headers['retry-after'], 10);
            if (Number.isFinite(ra)) retryAfterSec = ra;
          }
          return reject(new AiUnavailableError(
            `Sophia wrapper ${method} ${reqPath} failed (${res.statusCode}): ${code}`,
            statusToCode(res.statusCode, j && j.error), retryAfterSec));
        }
        if (j === null) {
          return reject(new AiUnavailableError(`Sophia wrapper ${method} ${reqPath} returned non-JSON on success: ${text.slice(0, 200)}`, 'bad_response'));
        }
        resolve({ status: res.statusCode, headers: res.headers, json: j });
      });
    });
    if (data !== null) req.write(data);
    req.end();
  });
}

function requireWrapper() {
  if (!isWrapperConfigured()) {
    throw new AiUnavailableError('Sophia wrapper not configured — set SOPHIA_WRAPPER_URL (https) and SOPHIA_WRAPPER_TOKEN', 'not_configured');
  }
}

// Live agent turn through the gateway. Agent MUST be 'main' until the
// BCB agent is provisioned in the gateway (anything else -> 501).
// Throws AiUnavailableError with a distinct code on every failure —
// callers MUST fall back to the batch queue, never to a fake reply.
// Defect (d): the 8000-char cap is enforced HERE, client-side, before
// any call is made. Defect (e): the client abort (wrapper timeout +
// 30s slack) is strictly longer than the wrapper timeout requested.
async function callWrapperChat({ message, userId, agent, sessionId, timeoutMs }) {
  requireWrapper();
  if (!message || !String(message).trim()) throw new AiUnavailableError('chat message is required', 'bad_request');
  if (String(message).length > PROMPT_MAX_CHARS) {
    throw new AiUnavailableError(`chat message is ${String(message).length} chars — capped at ${PROMPT_MAX_CHARS} chars`, 'prompt_too_long');
  }
  const wrapperTimeoutS = Math.min(Math.max(Math.round((timeoutMs || WRAPPER_CHAT_TIMEOUT_S * 1000) / 1000), 1), WRAPPER_CHAT_TIMEOUT_MAX_S);
  const clientTimeoutMs = wrapperTimeoutS * 1000 + CLIENT_TIMEOUT_SLACK_MS;
  const { json: j } = await wrapperRequest({
    method: 'POST', path: '/v1/chat',
    body: { app: 'bcb', agent: agent || 'main', message, user_id: userId || 'bcb-coordinator', session_id: sessionId || undefined, timeout: wrapperTimeoutS },
    timeoutMs: clientTimeoutMs,
  });
  const reply = j && (j.reply ?? (typeof j.raw === 'string' ? j.raw : null));
  if (typeof reply !== 'string' || !reply.trim()) throw new AiUnavailableError('wrapper chat returned no reply text', 'bad_response');
  return { reply, raw: j };
}

// Async batch job through the wrapper. Returns { jobId } — poll with
// pollWrapperBatch(jobId) or runWrapperBatch(...).
// Defect (d): the 8000-char cap is enforced HERE, client-side, before
// any call is made (the wrapper enforces it too — the client check is
// so a too-long prompt fails fast with prompt_too_long, not as a
// wasted queued job).
async function callWrapperBatch({ task, prompt, userId, timeoutMs }) {
  requireWrapper();
  if (!prompt || !String(prompt).trim()) throw new AiUnavailableError('batch prompt is required', 'bad_request');
  if (String(prompt).length > PROMPT_MAX_CHARS) {
    throw new AiUnavailableError(`batch prompt is ${String(prompt).length} chars — capped at ${PROMPT_MAX_CHARS} chars`, 'prompt_too_long');
  }
  const wrapperTimeoutS = Math.min(Math.max(Math.round((timeoutMs || WRAPPER_BATCH_TIMEOUT_S * 1000) / 1000), 1), WRAPPER_BATCH_TIMEOUT_MAX_S);
  const { json: j } = await wrapperRequest({
    method: 'POST', path: '/v1/batch',
    body: { app: 'bcb', task, prompt, user_id: userId || 'bcb-coordinator', timeout: wrapperTimeoutS },
    timeoutMs: BATCH_SUBMIT_TIMEOUT_MS, // submit only queues — 202 returns immediately
  });
  if (!j || !j.job_id) throw new AiUnavailableError('wrapper batch returned no job_id', 'bad_response');
  return { jobId: j.job_id, poll: j.poll };
}

async function pollWrapperBatch(jobId) {
  requireWrapper();
  if (!jobId) throw new AiUnavailableError('batch job id is required', 'bad_request');
  const { json: j } = await wrapperRequest({
    method: 'GET', path: `/v1/batch/${encodeURIComponent(jobId)}`,
    timeoutMs: BATCH_POLL_TIMEOUT_MS,
  });
  return j;
}

// Submit a batch job and poll it to a terminal state (done/failed/gated).
// Returns { status, result, error, jobId, elapsed_s }. The wrapper's
// result is PLAIN TEXT (the model was asked for a ```json fenced block);
// extractBatchJson() below pulls the JSON object out of it.
async function runWrapperBatch({ task, prompt, userId, timeoutMs, pollIntervalMs = 20000, maxWaitMs }) {
  const { jobId } = await callWrapperBatch({ task, prompt, userId, timeoutMs });
  const waitLimit = maxWaitMs || (WRAPPER_BATCH_TIMEOUT_S * 1000 + 5 * 60 * 1000);
  const started = Date.now();
  for (;;) {
    const j = await pollWrapperBatch(jobId);
    if (j && (j.status === 'done' || j.status === 'failed' || j.status === 'gated')) {
      return { status: j.status, result: j.result ?? null, error: j.error ?? null, jobId, elapsed_s: j.elapsed_s ?? null };
    }
    if (Date.now() - started > waitLimit) {
      throw new AiUnavailableError(`batch job ${jobId} did not finish within ${Math.round(waitLimit / 1000)}s of polling`, 'timeout');
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

// Extract the JSON payload from a batch result's plain text: prefer the
// last ```json fence, else the last {...} block, else the whole text as
// JSON. (Same rule the retired direct runner used — the wrapper returns
// the model's raw text, not a parsed object.)
function extractBatchJson(out) {
  const text = String(out || '');
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fences.length) return JSON.parse(fences[fences.length - 1][1]);
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  return JSON.parse(text);
}

// --- Batch prompts: templates + 8000-char measurement/compaction ---
// Templates live in lib/batch-prompts/ (copies of bcb-batch/jobs/ — the
// app dir is what deploys to Render, so the templates must live here;
// bcb-batch/jobs/ keeps reference copies, see its README).
const PROMPT_TEMPLATES = {};
for (const type of ['plan_video', 'playbook', 'network_watch', 'niche_check', 'draft_reply']) {
  try { PROMPT_TEMPLATES[type] = fs.readFileSync(path.join(__dirname, 'batch-prompts', `${type}.prompt.md`), 'utf8'); }
  catch { PROMPT_TEMPLATES[type] = null; }
}

// Build the /v1/batch prompt for a job: template + job JSON, measured
// against the 8000-char cap (defect (c)). Compaction NEVER drops the
// locked niche, the video, or the brief/comment — it trims, in order:
// portfolio items (keep first 2, then drop all), the latest plan, then
// long brief text. If it still does not fit, throw prompt_too_long with
// the measured length instead of silently truncating what the model
// needs to stay grounded.
function buildBatchPrompt(type, job) {
  const tpl = PROMPT_TEMPLATES[type];
  if (!tpl) throw new AiUnavailableError(`no batch prompt template for job type ${type}`, 'bad_request');
  const render = (jobObj) => tpl.replace('{{JOB_JSON}}', JSON.stringify(jobObj));
  const full = render(job);
  if (full.length <= PROMPT_MAX_CHARS) return { prompt: full, chars: full.length, compacted: false, dropped: [] };
  const dropped = [];
  const work = JSON.parse(JSON.stringify(job)); // deep copy — never mutate the stored job
  const payload = work.payload || {};
  const stages = [
    () => { // stage 1: portfolio down to the first 2 items
      if (Array.isArray(payload.portfolio) && payload.portfolio.length > 2) {
        const n = payload.portfolio.length - 2;
        payload.portfolio = payload.portfolio.slice(0, 2);
        dropped.push(`portfolio trimmed to first 2 items (${n} dropped)`);
        return true;
      }
      return false;
    },
    () => { // stage 2: drop the latest plan (title stays on the video)
      if (payload.latestPlan) { delete payload.latestPlan; dropped.push('latestPlan dropped'); return true; }
      return false;
    },
    () => { // stage 3: drop the portfolio entirely
      if (Array.isArray(payload.portfolio) && payload.portfolio.length) { delete payload.portfolio; dropped.push('portfolio dropped'); return true; }
      return false;
    },
    () => { // stage 4: trim a long brief to 1000 chars (niche/video untouched)
      if (typeof payload.brief === 'string' && payload.brief.length > 1000) {
        payload.brief = payload.brief.slice(0, 1000);
        dropped.push('brief trimmed to 1000 chars');
        return true;
      }
      return false;
    },
  ];
  for (const stage of stages) {
    if (!stage()) continue;
    const attempt = render(work);
    if (attempt.length <= PROMPT_MAX_CHARS) return { prompt: attempt, chars: attempt.length, compacted: true, dropped };
  }
  const attempt = render(work);
  throw new AiUnavailableError(
    `batch prompt for ${type} is ${attempt.length} chars even after compaction (${dropped.join('; ') || 'nothing left to trim'}) — capped at ${PROMPT_MAX_CHARS} chars`,
    'prompt_too_long');
}

// Backwards-compatible name: the old single-endpoint sketch is gone.
// callWrapper now means "one live chat turn" (the only synchronous call
// the deployed wrapper offers). Batch goes through callWrapperBatch.
async function callWrapper(opts) {
  return callWrapperChat(opts);
}

// Deterministic niche pre-check (NO model): does the video's topic/title
// share vocabulary with the client's LOCKED niche v1 (agreed/overridden
// niche record)? This is a guardrail tripwire, not the model niche check
// (bcb.niche_check, which is a batch job). Returns { pass, score, matched,
// reason }. A miss does NOT block a reply draft — it flags the video for
// the coordinator, because the locked rule is: remake is the default first
// instinct when a video misses the niche, and the coordinator decides.
function nichePreCheck({ video, niche }) {
  if (!niche || !niche.niche) return { pass: null, score: 0, matched: [], reason: 'no locked niche on file — niche agreement (Step 0) not complete' };
  const stop = new Set(('the a an and or of to in on for with my your our is it this that by at as be are was were from into over under after before about around'.split(' ')));
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const nicheWords = new Set([...words(niche.niche), ...(niche.pillars || []).flatMap(words), ...words(niche.promise), ...words(niche.format)]);
  const videoWords = [...words(video && video.title), ...words(video && video.topic), ...words(video && video.promise)];
  const matched = [...new Set(videoWords.filter((w) => nicheWords.has(w)))];
  const score = videoWords.length ? matched.length / new Set(videoWords).size : 0;
  const pass = matched.length > 0;
  return {
    pass,
    score: Math.round(score * 100) / 100,
    matched,
    reason: pass
      ? `shares vocabulary with locked niche v${niche.version}: ${matched.join(', ')}`
      : 'no shared vocabulary with locked niche — flag for coordinator; remake is the default first instinct when a video misses the niche',
  };
}

// MCP tools (F2) the BCB agent exposes. Names + input schemas match the
// deployed foundation wrapper's TOOLS list VERBATIM (server.py) so
// tools/call validation passes; the app-side implementation of each tool
// is the dispatch receiver POST /api/ai/mcp/:tool (see server.js).
// Dispatch body shape (verified by Wave 1B against server.py): the
// wrapper POSTs the raw tool arguments as JSON with header
// X-Sophia-Token: <service_token> — no envelope, no extra fields.
const MCP_TOOLS = [
  {
    name: 'bcb.plan_video',
    description: 'Plan a BCB video from a client brief: script outline, clips, captions, thumbnail, cost estimate. Returns a plan for approval.',
    inputSchema: { type: 'object', required: ['client_id', 'brief'], properties: { client_id: { type: 'string' }, brief: { type: 'string' }, niche: { type: 'string' } } },
    appRoute: 'POST /api/ai/mcp/bcb.plan_video -> enqueues plan_video batch job -> aiPlans[]',
  },
  {
    name: 'bcb.queue_generation',
    description: 'Queue generation of an approved BCB video plan. Cost must already have been shown to and approved by the coordinator.',
    inputSchema: { type: 'object', required: ['client_id', 'plan_id', 'cost_approved'], properties: { client_id: { type: 'string' }, plan_id: { type: 'string' }, cost_approved: { type: 'boolean' } } },
    appRoute: 'GATED — returns {status:"gated"} until F6 adapters + spend approval exist',
  },
  {
    name: 'bcb.publish',
    description: 'Publish a finished BCB video to the listed platforms on schedule.',
    inputSchema: { type: 'object', required: ['video_id', 'platforms'], properties: { video_id: { type: 'string' }, platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'facebook', 'instagram', 'tiktok'] } }, schedule: { type: 'string' } } },
    appRoute: 'GATED — returns {status:"gated"} until publish adapters exist (docs/publish-design.md)',
  },
  {
    name: 'bcb.draft_reply',
    description: 'Draft a first-hour reply to a comment on a BCB video. Draft only — never posts without coordinator approval.',
    inputSchema: { type: 'object', required: ['video_id', 'comment_text'], properties: { video_id: { type: 'string' }, comment_id: { type: 'string' }, comment_text: { type: 'string' } } },
    appRoute: 'POST /api/ai/mcp/bcb.draft_reply -> enqueues draft_reply batch job -> replies[] (aiGenerated:true)',
  },
  {
    name: 'bcb.niche_check',
    description: "Check a video/plan against a client's locked niche v1 before it is queued. A miss means remake is the default.",
    inputSchema: { type: 'object', required: ['client_id'], properties: { client_id: { type: 'string' }, video_id: { type: 'string' }, script: { type: 'string' } } },
    appRoute: 'POST /api/ai/mcp/bcb.niche_check -> enqueues niche_check batch job -> aiJobs[].result',
  },
];

module.exports = {
  WRAPPER_URL, WRAPPER_TOKEN, AI_TOKEN, SERVICE_TOKEN,
  WRAPPER_FINGERPRINT, WRAPPER_FINGERPRINT_DEFAULT,
  PROMPT_MAX_CHARS, WRAPPER_CHAT_TIMEOUT_S, WRAPPER_BATCH_TIMEOUT_S,
  CLIENT_TIMEOUT_SLACK_MS, BATCH_SUBMIT_TIMEOUT_MS, BATCH_POLL_TIMEOUT_MS,
  AiUnavailableError, isWrapperConfigured,
  callWrapper, callWrapperChat, callWrapperBatch, pollWrapperBatch, runWrapperBatch,
  buildBatchPrompt, extractBatchJson,
  nichePreCheck, MCP_TOOLS,
};
