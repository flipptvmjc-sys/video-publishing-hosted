// Video Publishing App — hosted copy.
// Node, no framework dependencies except optional `pg` when DATABASE_URL is set.
// Storage: Postgres when DATABASE_URL is set, otherwise a local JSON file
// (data.json, git-ignored). On a free host that sleeps / redeploys, the JSON
// file is NOT durable — for live clients, set DATABASE_URL to a free external
// Postgres (Supabase / Neon free tier) and the app uses that instead.
// The server never sends email or SMS itself. "Send via email / text" opens
// the coordinator's own email/text app with a prefilled mailto:/sms: message.
// That is honest: the code is text, it is not a clickable auto-login link,
// because the app has no way to embed its own public URL in the code itself.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const storage = require('./lib/storage');
const tiktok = require('./lib/tiktok');
const ai = require('./lib/ai');
const { slaInfo, SLA_MS } = require('./lib/sla');
const { diffPlan, normalizeWatchItem, diffWatchEditions, feedFreshness } = require('./lib/versions');
const publish = require('./lib/publish');
const tokens = require('./lib/tokens');
const comments = require('./lib/comments');
const portableTokens = require('./lib/portable-tokens');
// One-time pop handoffs for portable tokens (in-memory, per-process —
// a restart loses un-popped handoffs; that is the safe failure).
const portableHandoffs = new portableTokens.PopHandoffStore();

// Worker auth (Wave 2D): the VPS cron (publish worker + token sweep)
// calls /api/worker/* with this secret — Bearer or X-Worker-Token.
// Fails closed 503 when unset on the host, 401 on a wrong token.
// It is a DIFFERENT secret from BCB_AI_TOKEN / SOPHIA_SERVICE_TOKEN.
const WORKER_TOKEN = process.env.BCB_WORKER_TOKEN || '';

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// File uploads: Supabase free tier caps each file at 50MB and total file
// storage at 1GB. The server enforces the per-file cap up front so nobody
// sits through a doomed upload; the UI shows usage against the 1GB total.
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const STORAGE_TOTAL_BYTES = 1024 * 1024 * 1024;

const BANNED = ['666', '187', '911'];
function containsBanned(n) {
  const s = String(n);
  return BANNED.some((b) => s.includes(b));
}
function threeDigitPool() {
  const out = [];
  for (let n = 100; n <= 999; n++) if (!containsBanned(n)) out.push(n);
  return out; // 897 numbers
}
function pickAccountNumber(used) {
  const usedSet = new Set(used.map(Number));
  const pool = threeDigitPool().filter((n) => !usedSet.has(n));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  const four = [];
  for (let n = 1000; n <= 9999; n++) if (!containsBanned(n) && !usedSet.has(n)) four.push(n);
  if (!four.length) throw new Error('Account number pool exhausted');
  return four[Math.floor(Math.random() * four.length)];
}
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  const g = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${g()}-${g()}`;
}
function uid() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}

// ---------- JSON store (fallback) ----------
let db = null;
function emptyDb() {
  return { _rev: 0, coordinator: null, clients: [], codes: [], portfolio: [], niches: [], videos: [], audit: [], replies: [], coordinatorTokens: [], clientTokens: [], files: [], pendingUploads: [], tiktokOauthStates: [], tiktokTokens: [], platformTokens: [], webhookEvents: [], aiJobs: [], aiPlans: [], aiPlaybooks: [], aiWatch: [], portableTokens: [], portableTokenAudit: [] };
}
// Idempotent startup migration: backfills any keys missing from an older
// stored db (JSON file or the Postgres kv row) without touching existing data.
function migrateDb(d) {
  const e = emptyDb();
  for (const k of Object.keys(e)) if (d[k] === undefined || d[k] === null) d[k] = e[k];
  if (typeof d._rev !== 'number') d._rev = 0;
  // Wave 2D backfills — fill missing fields only, never rewrite stored values.
  for (const v of d.videos || []) {
    if (v.pausedAt === undefined) v.pausedAt = null;
    if (typeof v.pausedMsTotal !== 'number') v.pausedMsTotal = 0;
    // Per-platform publish records (Buffer state machine). A video
    // created before Wave 2D has no publish queue yet.
    if (!v.publish || typeof v.publish !== 'object') v.publish = {};
  }
  for (const r of d.replies || []) {
    if (!r.layer) r.layer = r.aiGenerated ? 'ai' : 'coordinator';
    if (!r.source) r.source = r.aiGenerated ? 'ai' : 'coordinator';
  }
  // Reply state machine: replies recorded before it existed were either
  // coordinator text (already sent by the coordinator) or AI drafts
  // (never approved). Coordinator text -> posted; AI drafts -> draft.
  for (const r of d.replies || []) {
    if (!r.status) r.status = r.aiGenerated ? 'draft' : 'posted';
    if (!r.statusAt) r.statusAt = r.createdAt || null;
  }
  // Plan versions: plans recorded before versioning get sequential
  // versions per video in creation order, all as unapproved drafts —
  // no approval was ever recorded for them, so none is invented.
  const byVideo = {};
  for (const p of d.aiPlans || []) {
    if (!byVideo[p.videoId || '']) byVideo[p.videoId || ''] = [];
    byVideo[p.videoId || ''].push(p);
  }
  for (const list of Object.values(byVideo)) {
    list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    list.forEach((p, i) => {
      if (typeof p.version !== 'number') p.version = i + 1;
      if (!p.status) p.status = 'draft';
    });
  }
  return d;
}
// Read the stored JSON file, tolerating a torn read from a concurrent
// writer: fs.writeFileSync truncates then writes, so a simultaneous
// read can see a partial file. Retry briefly; a file that stays
// unreadable is an error, never a silent empty db or a skipped
// revision check. ENOENT (first boot) is the only "missing" case.
// (Saves below are atomic temp+rename, so a torn read from our own
// writes should not happen — this guards against anything else
// touching the file mid-write.)
function readDbFile() {
  for (let i = 0; i < 20; i++) {
    try {
      return { exists: true, data: JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { exists: false, data: null };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  throw new Error('db file unreadable after retries — refusing to proceed (possible concurrent write in progress)');
}
function loadDb() {
  if (db) return db;
  const r = readDbFile();
  db = r.exists ? r.data : emptyDb();
  db = migrateDb(db);
  return db;
}
// Fresh load, bypassing the in-process cache — the read side of
// updateDb(). Always re-reads the stored copy so a retry sees the
// latest revision instead of the stale cached object.
async function loadFreshDb() {
  if (process.env.DATABASE_URL) return pgLoad();
  const r = readDbFile();
  db = r.exists ? r.data : emptyDb();
  db = migrateDb(db);
  return db;
}

// ---------- Optimistic versioning (Wave 2C) ----------
// The whole-object JSON blob used to overwrite concurrent writes: two
// writers loading rev N and both saving lost the first writer's work
// silently. Every stored db now carries `_rev`. A save succeeds only
// when the stored revision still equals the revision this copy was
// loaded at; otherwise it throws VersionConflictError instead of
// overwriting. updateDb() (below) is the write path for concurrent
// work: load fresh -> mutate -> save, retrying on conflict.
class VersionConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VersionConflictError';
    this.code = 'version_conflict';
  }
}
// Filesystem lock for the JSON-file save path (Wave 2C).
// The revision check-then-write in saveDb is a TOCTOU race across
// PROCESSES: two writers can both read rev R, both pass, and the
// second silently overwrites the first. (The suite caught this live —
// one run in six lost a write with no error.) mkdir is atomic, so a
// lock directory is the mutex: the whole read-check-write runs inside
// it. The locked section is fully synchronous, so a holder never yields
// mid-save. A lock older than 10s is treated as stale (a crashed writer)
// and removed. The Postgres path needs no lock — its UPDATE ... WHERE
// is atomic server-side.
function acquireDbLock() {
  const lockDir = `${DATA_FILE}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lockDir); return lockDir; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 10000) { fs.rmdirSync(lockDir); continue; }
      } catch {}
      if (Date.now() > deadline) throw new Error('db lock timeout — refusing to write (possible stuck writer)');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
function releaseDbLock(lockDir) { try { fs.rmdirSync(lockDir); } catch {} }
function saveDb(dObj) {
  // Save exactly the copy the caller mutated — NOT the module cache.
  // Two concurrent updateDb() calls in one process each hold their own
  // fresh copy; saving the cache would write the other caller's copy
  // and lose this one's mutation. Callers with no copy pass nothing
  // and the cache is used (the old behaviour).
  const d = dObj || loadDb();
  if (typeof d._rev !== 'number') d._rev = 0;
  const lock = acquireDbLock();
  try {
    const r = readDbFile();
    const storedRev = r.exists ? ((r.data && typeof r.data._rev === 'number') ? r.data._rev : 0) : null;
    if (r.exists && storedRev !== d._rev) {
      throw new VersionConflictError(`db revision conflict: stored rev ${storedRev}, this copy is rev ${d._rev} — reload and retry instead of overwriting`);
    }
    d._rev = d._rev + 1;
    // Atomic write: temp file + rename, so a concurrent reader never
    // sees a truncated half-written file.
    const tmp = `${DATA_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    db = d; // the saved copy is now the cache
  } finally {
    releaseDbLock(lock);
  }
}

// Retry a mutation against the stored db: load a fresh copy, apply the
// (synchronous, idempotent) mutator, save with a revision check, and
// retry from a fresh load when another writer landed first. Returns
// { db, result } where result is whatever the mutator returned on the
// final, saved attempt. Throws VersionConflictError after retries run out.
async function updateDb(mutator, { retries = 5 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const d = await loadFreshDb();
    const result = mutator(d);
    try {
      // Save THIS copy (putDb(d)), not the module cache — a concurrent
      // updateDb in the same process may have replaced the cache with
      // its own fresh copy by now.
      await putDb(d);
      return { db: d, result };
    } catch (e) {
      if (e instanceof VersionConflictError) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr;
}

// ---------- Postgres store (when DATABASE_URL set) ----------
// Tables are created on first boot. This keeps the same JSON-shaped rows.
let pgPool = null;
async function pg() {
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgPool.query(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
  }
  return pgPool;
}
async function pgLoad() {
  const pool = await pg();
  const r = await pool.query('SELECT v FROM kv WHERE k=$1', ['db']);
  if (r.rows.length) { db = migrateDb(r.rows[0].v); return db; }
  db = emptyDb();
  await pool.query('INSERT INTO kv(k,v) VALUES($1,$2)', ['db', JSON.stringify(db)]);
  return db;
}
async function pgSave(dObj) {
  // Compare-and-swap on _rev: the UPDATE only lands when the stored
  // revision still equals the revision this copy was loaded at. Zero
  // rows + an existing row = another writer landed first (conflict);
  // zero rows + no row = first boot (insert). Saves the passed copy,
  // not the module cache (same reason as saveDb).
  const pool = await pg();
  const d = dObj || db;
  if (typeof d._rev !== 'number') d._rev = 0;
  const expected = d._rev;
  const next = { ...d, _rev: expected + 1 };
  const r = await pool.query(
    `UPDATE kv SET v=$2 WHERE k='db' AND COALESCE((v->>'_rev')::int, 0)=$1`,
    [expected, JSON.stringify(next)],
  );
  if (r.rowCount === 0) {
    const exists = await pool.query('SELECT 1 FROM kv WHERE k=$1', ['db']);
    if (exists.rows.length) {
      throw new VersionConflictError(`db revision conflict: stored rev moved past ${expected} — reload and retry instead of overwriting`);
    }
    await pool.query('INSERT INTO kv(k,v) VALUES($1,$2)', ['db', JSON.stringify(next)]);
  }
  d._rev = expected + 1;
  db = d;
}
async function getDb() { return process.env.DATABASE_URL ? pgLoad() : loadDb(); }
async function putDb(d) { return process.env.DATABASE_URL ? pgSave(d) : saveDb(d); }

function audit(d, clientId, type, text) {
  d.audit.push({ id: uid(), clientId, type, text, createdAt: new Date().toISOString() });
}
function clientView(d, c) {
  const codes = d.codes.filter((x) => x.clientId === c.id);
  const active = codes.find((x) => !x.revoked && new Date(x.expiresAt) > new Date());
  const videos = d.videos.filter((v) => v.clientId === c.id).map((v) => ({ id: v.id, title: v.title, status: v.status }));
  return { ...c, codes, videos, activeCode: active || null, bridgeConnected: codes.some((x) => x.opens > 0), lastOpenedAt: codes.reduce((m, x) => (x.lastOpenedAt && (!m || x.lastOpenedAt > m) ? x.lastOpenedAt : m), null) };
}
function requireCoordinator(d, req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return t && d.coordinatorTokens.some((x) => x.token === t) ? t : null;
}
function requireClient(d, req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = d.clientTokens.find((x) => x.token === t);
  return s || null;
}
// Who is calling an uploads/files route? { role: 'coordinator' } or
// { role: 'client', clientId } or null.
function callerIdentity(d, req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  if (d.coordinatorTokens.some((x) => x.token === t)) return { role: 'coordinator' };
  const s = d.clientTokens.find((x) => x.token === t);
  return s ? { role: 'client', clientId: s.clientId } : null;
}
function sanitizeFilename(name) {
  const s = String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return s || 'file';
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function mailtoLink(client, code, baseUrl) {
  const clientUrl = `${baseUrl}/client`;
  const subject = encodeURIComponent(`Your Video Publishing page — account #${client.accountNumber}`);
  const bodyText = `Hi ${client.name},\n\nYour Video Publishing page is ready.\n\nStep 1: open your client page at ${clientUrl}\nStep 2: type this code on the first screen: ${code.code}\n\nYour account number is ${client.accountNumber}. The code expires in 7 days.\n\nThis code is not a clickable link — please open the page above and type the code in.`;
  return `mailto:${encodeURIComponent(client.email)}?subject=${subject}&body=${encodeURIComponent(bodyText)}`;
}
function smsLink(client, code, baseUrl) {
  const clientUrl = `${baseUrl}/client`;
  const text = `Hi ${client.name}, your Video Publishing page is ready. Open ${clientUrl}, then type this code: ${code.code} (account #${client.accountNumber}, expires in 7 days). The code is not a clickable link — open the page and type it in.`;
  return `sms:${encodeURIComponent(client.phone || '')}?body=${encodeURIComponent(text)}`;
}
// Version badge — environment flag, same code in both places.
// Hosted deployment MUST set APP_VERSION=live. Any other value (including
// unset, which is how the Muse artifact runs) shows the Muse marker.
// This is deliberate: the hosted copy can never accidentally show the Muse
// badge, and the Muse copy can never accidentally show LIVE, because the
// badge is decided by the deployment environment, not by a hard-coded label
// that could be copied across.
function versionBadge() {
  if (String(process.env.APP_VERSION || '').toLowerCase() === 'live') {
    return { env: 'live', label: 'LIVE', dot: '●', colour: '#16a34a', background: '#dcfce7', text: '● LIVE' };
  }
  return { env: 'muse', label: 'MUSE — TEST / FIXING', dot: '◆', colour: '#b45309', background: '#fef3c7', text: '◆ MUSE — TEST / FIXING' };
}
function fullMessage(client, code, baseUrl) {
  const clientUrl = `${baseUrl}/client`;
  return `Hi ${client.name}, your Video Publishing page is ready.\n\nStep 1: open your client page at ${clientUrl}\nStep 2: type this code on the first screen: ${code.code}\n\nYour account number is ${client.accountNumber}. The code expires in 7 days.\nThis code is not a clickable link — open the page above and type the code in.`;
}

// ---------- TikTok Login Kit OAuth ----------
// The redirect URI registered in the TikTok developer portal must match
// exactly. It is derived from the public host of each request, so the URI
// to paste into TikTok's "Login Kit Web Redirect URI" field is:
//   https://video-publishing-hosted.onrender.com/auth/tiktok/callback
function tiktokRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host || 'localhost'}/auth/tiktok/callback`;
}
// Coordinator auth for the login route, which is a plain browser navigation
// (no fetch headers): accepts the Bearer header OR a ?token= query param.
function requireCoordinatorFlexible(d, req, u) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || u.searchParams.get('token') || '';
  return t && d.coordinatorTokens.some((x) => x.token === t) ? t : null;
}
// Simple HTML result pages for the OAuth callback (TikTok redirects the
// coordinator's own browser here, so JSON would be a dead end).
function oauthPage(res, code, title, message, ok) {
  const colour = ok ? '#16a34a' : '#b91c1c';
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,Arial,sans-serif;max-width:640px;margin:60px auto;padding:20px;color:#241b2e"><h1 style="color:${colour}">${title}</h1><p style="font-size:18px">${message}</p><p><a href="/" style="color:#6b21a8;font-weight:700">Back to the coordinator desk</a></p></body></html>`);
}
// Returns { accessToken, openId } for a client, refreshing the TikTok token
// when it is expired or nearly so. Returns null when the client has never
// connected TikTok. Exported for the future Content Posting wiring.
async function getValidTiktokToken(d, clientId, httpPost) {
  const rec = tiktok.findVaultRecord(d.tiktokTokens, clientId, 'tiktok');
  if (!rec) return null;
  const key = tiktok.deriveVaultKey(d);
  const tok = tiktok.readVaultRecord(rec, key);
  if (tiktok.isTokenFresh(rec.expiresAt)) return { accessToken: tok.accessToken, openId: tok.openId };
  const fresh = await tiktok.refreshAccessToken({ refreshToken: tok.refreshToken, httpPost });
  const next = tiktok.buildVaultRecord({ clientId, network: 'tiktok', tokenJson: { ...fresh, refresh_token: fresh.refresh_token || tok.refreshToken, open_id: fresh.open_id || tok.openId }, key });
  next.createdAt = rec.createdAt;
  const i = d.tiktokTokens.indexOf(rec);
  d.tiktokTokens[i] = next;
  await putDb(d);
  return { accessToken: fresh.access_token, openId: fresh.open_id || tok.openId };
}

// ---------- Publish worker helpers (Wave 2D) ----------
// Token resolution for one publish attempt — layers 2 + 3 of the
// token-health system (report §2.2): pre-slot check (refresh on the
// spot when close to expiry) + pre-call validation (expiry checked
// before the adapter is called; runPublishAttempt re-checks it).
// TikTok has a real refresh path (lib/tiktok.js). YouTube /
// Instagram / Facebook have no refresh path until their adapters
// exist — an expired record there reports as expired, never as
// refreshed. Throws on refresh failure so the caller can mark the
// account EXPIRED with the platform's own message.
async function resolvePublishToken(d, clientId, platform) {
  if (platform === 'tiktok') {
    // getValidTiktokToken refreshes when stale; a throw means the
    // refresh itself failed (platform's message preserved).
    return getValidTiktokToken(d, clientId);
  }
  const rec = tiktok.findVaultRecord(d.platformTokens, clientId, platform);
  if (!rec) return null;
  if (rec.status === 'expired') return { accessToken: null, openId: rec.openId, expired: true, expiredReason: rec.expiredReason || null };
  const health = tokens.tokenHealth(rec);
  if (health.status === 'expired') return { accessToken: null, openId: rec.openId, expired: true, expiredReason: health.reason };
  const key = tiktok.deriveVaultKey(d);
  const tok = tiktok.readVaultRecord(rec, key);
  return { accessToken: tok.accessToken, openId: tok.openId, expiresAt: rec.expiresAt };
}
// The final video file's URL, signed fresh AT ATTEMPT TIME (24h —
// the IG container lifetime), so a publish never fails on a stale
// 300s signed URL. Returns null when there is no final file or
// storage is not configured — an honest refusal, not a silent skip.
async function resolvePublishFileUrl(video) {
  const d = await getDb();
  const finals = d.files.filter((f) => f.video_id === video.id && f.kind === 'final')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (!finals.length) return null;
  try {
    return await storage.createDownloadUrl(finals[0].storage_path, 24 * 3600);
  } catch {
    return null;
  }
}
// Run every due publish record for ONE video (scheduled-and-due, or
// a retry that is due with attempts left). Mutates d in place; the
// caller saves. Auth failures mark the account EXPIRED (death as a
// visible state) and fail the post with the platform's own message.
// Returns [{ platform, outcome, kind }] — never throws for a single
// platform's failure; a platform failure must not kill the others
// (3 of 4 live is the dangerous state — surface it, don't hide it).
async function processDuePublishesForVideo(d, video, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const due = publish.duePublishes([video], now);
  const outcomes = [];
  for (const item of due) {
    const record = item.record;
    let outcome;
    try {
      const getToken = async (clientId, platform) => resolvePublishToken(d, clientId, platform);
      outcome = await publish.runPublishAttempt({
        video, platform: item.platform, record,
        getToken, getFileUrl: resolvePublishFileUrl, nowMs: now,
      });
    } catch (e) {
      // runPublishAttempt is not supposed to throw, but a token
      // resolver failure must not take the other platforms down.
      outcome = { outcome: 'error', kind: 'unknown', record };
      record.lastError = { kind: 'unknown', message: String(e.message || e), at: new Date().toISOString() };
      record.errorText = `Publish worker error: ${String(e.message || e)}`;
      record.updatedAt = new Date().toISOString();
    }
    if (outcome.auth) {
      const reason = (record.lastError && record.lastError.message) || `${item.platform} token invalid or expired`;
      const marked = tokens.markAccountExpired(d, video.clientId, item.platform, reason);
      audit(d, video.clientId, 'token_expired', `${item.platform} account marked EXPIRED: ${reason} — ${marked.recordsFailed} publish record(s) failed, reconnect required`);
    }
    audit(d, video.clientId, `publish_${outcome.outcome}`, `Publish ${outcome.outcome} on ${item.platform} for "${video.title}"${record.errorText ? ` — ${record.errorText}` : ''}${record.postId ? ` (post ${record.postId})` : ''}`);
    outcomes.push({ platform: item.platform, outcome: outcome.outcome, kind: outcome.kind || null, record });
  }
  return outcomes;
}

// Shared job-context enrichment (defect (j)): coordinator jobs and MCP
// jobs get EXACTLY the same context — the client record, the locked
// niche v1, the client portfolio, and (for video jobs) the video record
// + latest plan. A batch job must never receive an empty payload: the
// model is forbidden to invent client facts, so an empty payload can
// only come back as a placeholder + failed niche check. The server owns
// the context; the model only writes from it.
function buildJobContext(d, { videoId, clientId }) {
  const video = videoId ? d.videos.find((v) => v.id === videoId) : null;
  const cid = (video && video.clientId) || clientId || null;
  const client = cid ? d.clients.find((c) => c.id === cid) : null;
  const niches = cid ? d.niches.filter((x) => x.clientId === cid) : [];
  const locked = niches.find((x) => x.status === 'agreed' || x.status === 'overridden') || niches[niches.length - 1] || null;
  const context = {
    client: client ? { id: client.id, name: client.name, approvalMode: client.approvalMode } : null,
    lockedNiche: locked ? { niche: locked.niche, pillars: locked.pillars, format: locked.format, promise: locked.promise, version: locked.version, status: locked.status } : null,
    portfolio: cid ? d.portfolio.filter((x) => x.clientId === cid).map((x) => ({ text: x.text, links: x.links, outcome: x.outcome })) : [],
  };
  if (video) {
    context.video = { id: video.id, title: video.title, topic: video.topic, promise: video.promise, links: video.links, ctas: video.ctas, series: video.series, episode: video.episode, status: video.status, schedule: video.schedule };
    const plan = d.aiPlans.filter((x) => x.videoId === video.id).slice(-1)[0];
    if (plan) context.latestPlan = { title: plan.title, script: plan.script, captions: plan.captions, thumbnail: plan.thumbnail };
  }
  return context;
}

// Result-schema validation on ingest: a result missing the fields its
// job type requires is malformed — the job is marked failed with a
// reason and NOTHING is stored as a plan/playbook/watch/reply.
// Returns null when valid, else a human-readable reason.
function validateJobResult(type, result) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!isObj(result)) return 'result is not a JSON object';
  switch (type) {
    case 'plan_video':
      if (!nonEmptyStr(result.title)) return 'missing required field: title (non-empty string)';
      if (!isObj(result.script) || !nonEmptyStr(result.script.hook) || !Array.isArray(result.script.beats) || !nonEmptyStr(result.script.cta)) return 'missing required field: script {hook, beats[], cta}';
      if (!isObj(result.nicheCheck) || !['pass', 'fail'].includes(result.nicheCheck.verdict)) return 'missing required field: nicheCheck.verdict (pass|fail)';
      return null;
    case 'playbook':
      if (!nonEmptyStr(result.niche)) return 'missing required field: niche (non-empty string)';
      if (!Array.isArray(result.pillars)) return 'missing required field: pillars (array)';
      if (!nonEmptyStr(result.cadence)) return 'missing required field: cadence (non-empty string)';
      return null;
    case 'network_watch':
      if (!nonEmptyStr(result.weekOf)) return 'missing required field: weekOf (YYYY-MM-DD)';
      if (!Array.isArray(result.platformChanges)) return 'missing required field: platformChanges (array)';
      return null;
    case 'niche_check':
      if (!['pass', 'fail'].includes(result.verdict)) return 'missing required field: verdict (pass|fail)';
      if (!Array.isArray(result.reasons)) return 'missing required field: reasons (array)';
      return null;
    case 'draft_reply':
      if (result.send !== undefined && typeof result.send !== 'boolean') return 'field send must be a boolean';
      if (result.reply !== undefined && typeof result.reply !== 'string') return 'field reply must be a string';
      if (result.reply === undefined && result.send !== false) return 'missing required field: reply';
      return null;
    default: return null;
  }
}

// Shared ingest: validates the result, enforces the DO-NOT-SEND +
// empty-reply guards, and stores it in the right collection. Used by
// BOTH the HTTP ingest endpoint and the wrapper-batch poller — one set
// of rules, no path that stores a malformed result or a reply that must
// never be sent. Mutates d + job; the caller saves + responds.
// Returns { stored, flagged, note }.
function ingestJobResult(d, job, { status, result, error }) {
  job.status = status === 'failed' ? 'failed' : 'done';
  job.error = error || null;
  job.completedAt = new Date().toISOString();
  if (job.status === 'failed') {
    audit(d, job.clientId, 'ai_job_failed', `AI batch job failed: ${job.type} — ${job.error || 'no reason given'}`);
    return { stored: false, flagged: false, note: null };
  }
  const malformed = validateJobResult(job.type, result || {});
  if (malformed) {
    job.status = 'failed';
    job.error = `malformed result — ${malformed}; nothing was stored`;
    job.result = result || {};
    audit(d, job.clientId, 'ai_job_failed', `AI batch job failed: ${job.type} — malformed result (${malformed}); nothing stored`);
    return { stored: false, flagged: false, note: job.error };
  }
  job.result = result || {};
  // Draft-reply guards (defects (h) + (i)): DO-NOT-SEND, a send:false
  // verdict, or an empty/whitespace reply is NEVER stored as an AI
  // reply. The job is done with a flagged note instead.
  if (job.type === 'draft_reply') {
    const text = typeof job.result.reply === 'string' ? job.result.reply : '';
    const sendFalse = job.result.send === false;
    if (text.trim() === 'DO-NOT-SEND' || sendFalse || !text.trim()) {
      const note = text.trim() === 'DO-NOT-SEND'
        ? 'The model flagged this comment as off-niche, hostile, or spam (DO-NOT-SEND) — no reply stored.'
        : sendFalse
          ? `The model declined to draft a reply${job.result.flag ? `: ${job.result.flag}` : ''} — no reply stored.`
          : 'The model returned an empty reply — no reply stored.';
      job.result.flagged = true;
      job.result.note = note;
      audit(d, job.clientId, 'reply_flagged', `AI reply flagged, not stored (${job.type}): ${note}`);
      return { stored: false, flagged: true, note };
    }
  }
  if (job.type === 'plan_video') {
    // Versioned plans (Wave 2C): the new version arrives as a DRAFT
    // with a visible diff against the previous version. Earlier DRAFT
    // versions are superseded; an APPROVED version stays approved until
    // the coordinator explicitly approves the new one — a new version
    // never silently overwrites an approved caption/plan.
    const siblings = d.aiPlans.filter((x) => x.videoId === job.videoId);
    const version = siblings.reduce((m, x) => Math.max(m, x.version || 0), 0) + 1;
    const prev = siblings.slice().sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;
    const plan = { id: uid(), jobId: job.id, videoId: job.videoId, clientId: job.clientId, ...job.result, version, status: 'draft', statusAt: job.completedAt, diffVs: diffPlan(prev, job.result), createdAt: job.completedAt };
    for (const s of siblings) if (s.status === 'draft') { s.status = 'superseded'; s.supersededBy = plan.id; }
    d.aiPlans.push(plan);
    job.result.planId = plan.id;
    job.result.planVersion = version;
  } else if (job.type === 'playbook') {
    const pb = { id: uid(), jobId: job.id, clientId: job.clientId, ...job.result, createdAt: job.completedAt };
    d.aiPlaybooks.push(pb);
    job.result.playbookId = pb.id;
  } else if (job.type === 'network_watch') {
    // Trend-feed schema (Wave 2C): every item normalized to
    // {platform, claim, sourceUrl, sourceGrade, publishedAt, observedAt,
    // affectsClients[]}; anything without a source is graded
    // "unverified", never presented as researched. The edition carries
    // a diff vs the previous edition (added / changed / removed).
    const items = (Array.isArray(job.result.platformChanges) ? job.result.platformChanges : [])
      .map((raw) => normalizeWatchItem(raw, job.completedAt));
    const prev = d.aiWatch.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null;
    const w = { id: uid(), jobId: job.id, ...job.result, items, diff: diffWatchEditions(prev ? prev.items : [], items), createdAt: job.completedAt };
    d.aiWatch.push(w);
    job.result.watchId = w.id;
  } else if (job.type === 'draft_reply') {
    const video = d.videos.find((v) => v.id === job.videoId);
    // Draft-first: an AI-drafted reply lands as status "draft" — it is
    // not posted until the coordinator approves it (see the reply
    // state machine: draft -> approved -> posted -> rejected).
    const reply = { id: uid(), videoId: job.videoId, text: job.result.reply, aiGenerated: true, model: job.result.model || 'claude-code-batch', nicheCheck: job.result.nicheCheck || null, comment: (job.payload && job.payload.comment) || '', status: 'draft', statusAt: job.completedAt, createdAt: job.completedAt };
    d.replies.push(reply);
    job.result.replyId = reply.id;
    if (video) audit(d, video.clientId, 'reply', 'First-hour AI reply drafted by batch model');
  }
  // niche_check jobs keep their verdict on the job record only.
  audit(d, job.clientId, 'ai_job_done', `AI batch job done: ${job.type}`);
  return { stored: true, flagged: false, note: null };
}

// Shared webhook-intake processing (Wave 2D): turns normalised Meta
// events into webhook-event records + (keyword draft | AI draft job |
// ignored). Pure mutation of d — the caller saves and kicks any jobs
// returned. Exported for tests: the HTTP layer only proves signature
// + dedupe; this function proves the two-layer reply flow.
function processMetaEvents(d, events) {
  const results = [];
  const jobsToKick = [];
  for (const ev of events) {
    // Dedupe by message id — Meta retries for up to 36h.
    const dup = d.webhookEvents.find((x) => x.eventId === ev.eventId);
    if (dup) { results.push({ eventId: ev.eventId, status: 'duplicate' }); continue; }
    // Match the comment to a video by the platform media id in
    // postLinks (only a published video can receive comments).
    let video = null;
    if (ev.mediaId) {
      video = d.videos.find((v) => Object.values(v.postLinks || {}).some((link) => link && String(link).includes(String(ev.mediaId)))) || null;
    }
    const rec = { id: uid(), eventId: ev.eventId, kind: ev.kind, platform: ev.platform, commentId: ev.commentId, from: ev.from, text: ev.text, mediaId: ev.mediaId, videoId: video ? video.id : null, status: 'received', layer: null, replyId: null, jobId: null, reason: null, receivedAt: new Date().toISOString() };
    const decision = comments.decideIntakeAction(ev);
    const firstHour = video ? comments.firstHourInfo(video) : null;
    rec.withinFirstHour = firstHour ? firstHour.active : null;
    if (decision.action === 'ignored') {
      rec.status = 'ignored';
      rec.reason = decision.reason;
    } else if (!video) {
      // No matching video: the event is kept, but no reply can
      // be drafted without a video + niche context — the model
      // is forbidden to invent client facts.
      rec.status = 'needs_video';
      rec.reason = 'no published video matches this comment\'s media id — link it manually before drafting a reply';
    } else if (decision.action === 'keyword_draft') {
      // Layer 1: deterministic one-sentence reply routing to
      // DM. Ready instantly — and still a DRAFT until the
      // coordinator approves it (draft-first, no auto-post).
      const reply = { id: uid(), videoId: video.id, text: comments.capReply(decision.replyText), aiGenerated: false, source: 'webhook', layer: 'keyword', keyword: decision.keyword, commentEventId: ev.eventId, comment: ev.text, commenter: ev.from, withinFirstHour: rec.withinFirstHour, status: 'draft', statusAt: rec.receivedAt, createdAt: rec.receivedAt };
      d.replies.push(reply);
      rec.status = 'keyword_draft';
      rec.layer = 'keyword';
      rec.replyId = reply.id;
      audit(d, video.clientId, 'reply', `Keyword reply drafted (layer 1, "${decision.keyword}") for a ${ev.platform} comment — awaiting coordinator approval`);
    } else {
      // Layer 2: AI draft job (niche + playbook + conversation
      // context, 280-char cap) — same ingest rules as every
      // other draft_reply job, DO-NOT-SEND included.
      const context = buildJobContext(d, { videoId: video.id, clientId: video.clientId });
      const nicheCheck = ai.nichePreCheck({ video, niche: context.lockedNiche });
      const job = { id: uid(), type: 'draft_reply', videoId: video.id, clientId: video.clientId, payload: { ...context, niche: context.lockedNiche, comment: ev.text, commenter: ev.from, nicheCheck }, status: 'queued', result: null, error: null, createdAt: rec.receivedAt, completedAt: null };
      d.aiJobs.push(job);
      jobsToKick.push(job.id);
      rec.status = 'ai_queued';
      rec.layer = 'ai';
      rec.jobId = job.id;
      audit(d, video.clientId, 'reply_queued', `AI reply drafted via webhook (${ev.platform} comment) — job ${job.id}`);
    }
    d.webhookEvents.push(rec);
    results.push({ eventId: ev.eventId, status: rec.status, videoId: rec.videoId, layer: rec.layer });
  }
  return { results, jobsToKick };
}

// App-side wrapper-batch poller (defect (c)): submit a queued aiJob to
// POST /v1/batch, poll GET /v1/batch/:id to a terminal state, then
// ingest through ingestJobResult — the same validation + guards as the
// HTTP ingest path. Fire-and-forget via kickWrapperJob(): it never
// throws to its caller; failures land on the job record with the mapped
// wrapper error code. The wrapper itself gates one job at a time + the
// 300 MiB floor; this poller only ever has one outstanding poll per job.
// The gateway is NEVER stopped by this code — a `gated` refusal is the
// mechanism, not a reason to touch any service.
const WRAPPER_POLL_INTERVAL_MS = 20000;
const WRAPPER_POLL_MAX_WAIT_MS = 15 * 60 * 1000;
// Mark one batch job failed through updateDb (revision-checked, retried
// on conflict) so a concurrent desk write cannot lose the failure —
// or the failure lose the desk write. The poller uses this for every
// terminal failure instead of mutating a possibly-stale copy + putDb.
async function failJob(jobId, message) {
  await updateDb((d) => {
    const j = d.aiJobs.find((x) => x.id === jobId);
    if (!j) return;
    j.status = 'failed';
    j.error = message;
    j.completedAt = new Date().toISOString();
    audit(d, j.clientId, 'ai_job_failed', `AI batch job failed: ${j.type} — ${message}`);
  });
}
async function runWrapperJob(jobId) {
  let dd = await getDb();
  let job = dd.aiJobs.find((x) => x.id === jobId);
  if (!job || job.status !== 'queued') return;
  let prompt;
  let compactNote = null;
  try {
    const built = ai.buildBatchPrompt(job.type, job);
    prompt = built.prompt;
    if (built.compacted) compactNote = `Batch prompt for ${job.type} compacted to ${built.chars} chars (${built.dropped.join('; ')})`;
  } catch (e) {
    await failJob(jobId, e.message);
    return;
  }
  // Submit (one retry after Retry-After on 429).
  let wrapperJobId = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await ai.callWrapperBatch({ task: job.type, prompt, userId: 'bcb-coordinator' });
      wrapperJobId = out.jobId;
      break;
    } catch (e) {
      if (e && e.code === 'rate_limited' && attempt === 0) {
        const waitMs = Math.min(Math.max((e.retryAfterSec || 60) * 1000, 1000), 65000);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      await failJob(jobId, `wrapper batch submit failed (${(e && e.code) || 'unknown'}): ${e.message}`);
      return;
    }
  }
  await updateDb((d2) => {
    const j = d2.aiJobs.find((x) => x.id === jobId);
    if (!j) return;
    j.wrapperJobId = wrapperJobId;
    j.status = 'running';
    if (compactNote) audit(d2, j.clientId, 'ai_job_compacted', compactNote);
  });
  // Poll to a terminal state.
  const started = Date.now();
  let consecutivePollErrors = 0;
  for (;;) {
    let polled;
    try {
      polled = await ai.pollWrapperBatch(wrapperJobId);
      consecutivePollErrors = 0;
    } catch (e) {
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= 5 || Date.now() - started > WRAPPER_POLL_MAX_WAIT_MS) {
        await failJob(jobId, `wrapper batch poll failed (${(e && e.code) || 'unknown'}): ${e.message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, WRAPPER_POLL_INTERVAL_MS));
      continue;
    }
    if (polled && (polled.status === 'done' || polled.status === 'failed' || polled.status === 'gated')) {
      if (polled.status === 'done') {
        let parsed;
        try { parsed = ai.extractBatchJson(polled.result); }
        catch (e) {
          await failJob(jobId, 'wrapper batch result was not parseable JSON — nothing was stored');
          return;
        }
        if (parsed && typeof parsed === 'object' && !parsed.model) parsed.model = 'sophia-wrapper-batch';
        await updateDb((d2) => {
          const j = d2.aiJobs.find((x) => x.id === jobId);
          if (j) ingestJobResult(d2, j, { status: 'done', result: parsed });
        });
      } else {
        await failJob(jobId, polled.error || `wrapper batch job ${polled.status}`);
      }
      return;
    }
    if (Date.now() - started > WRAPPER_POLL_MAX_WAIT_MS) {
      await failJob(jobId, `wrapper batch job ${wrapperJobId} did not finish within ${Math.round(WRAPPER_POLL_MAX_WAIT_MS / 1000)}s of polling`);
      return;
    }
    await new Promise((r) => setTimeout(r, WRAPPER_POLL_INTERVAL_MS));
  }
}
function kickWrapperJob(jobId) {
  if (!ai.isWrapperConfigured()) return; // batch-only mode: the job waits until the wrapper is configured
  runWrapperJob(jobId).catch((e) => console.error(`wrapper batch poller failed for job ${jobId}:`, e));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    // ---------- Meta comment intake (Wave 2D) ----------
    // POST /webhooks/meta — webhook push, not polling (report §5).
    // Signature (X-Hub-Signature-256, HMAC-SHA256 with META_APP_SECRET)
    // is verified BEFORE trusting the body; the event is enqueued and
    // 200 returns fast; Meta retries failed deliveries for up to 36h,
    // so events dedupe by message id. GET is the verification
    // handshake (hub.verify_token + hub.challenge). No coordinator
    // auth here — Meta calls this, not the coordinator. Fails closed:
    // 503 while META_APP_SECRET / META_VERIFY_TOKEN are unset.
    // DRAFT-FIRST: nothing this endpoint creates is ever posted
    // automatically — keyword replies land as drafts, everything else
    // enqueues an AI draft job. DO-NOT-SEND applies on this path too:
    // an empty comment is recorded as ignored, never drafted.
    if (p === '/webhooks/meta') {
      if (req.method === 'GET') {
        if (!process.env.META_VERIFY_TOKEN) return send(res, 503, { error: 'Meta webhook is not configured — set META_VERIFY_TOKEN on the server' });
        const hs = comments.verifyHandshake({ mode: u.searchParams.get('hub.mode'), verifyToken: u.searchParams.get('hub.verify_token'), challenge: u.searchParams.get('hub.challenge'), expectedToken: process.env.META_VERIFY_TOKEN });
        if (!hs.ok) return send(res, 403, { error: 'Webhook verification failed — hub.verify_token does not match' });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(hs.challenge);
      }
      if (req.method === 'POST') {
        if (!process.env.META_APP_SECRET) return send(res, 503, { error: 'Meta webhook is not configured — set META_APP_SECRET on the server' });
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        const sig = req.headers['x-hub-signature-256'] || '';
        if (!comments.verifyMetaSignature({ rawBody: raw, signature: sig, appSecret: process.env.META_APP_SECRET })) {
          return send(res, 401, { error: 'Invalid webhook signature — X-Hub-Signature-256 does not match the app secret' });
        }
        let payload;
        try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: 'Webhook body is not valid JSON' }); }
        const events = comments.normalizeMetaEvents(payload);
        const d = await getDb();
        const { results, jobsToKick } = processMetaEvents(d, events);
        await putDb(d);
        for (const jobId of jobsToKick) kickWrapperJob(jobId);
        return send(res, 200, { ok: true, received: events.length, results });
      }
      return send(res, 405, { error: 'Method not allowed' });
    }
    // TikTok OAuth endpoints (browser flows, not /api/ JSON routes).
    if (p.startsWith('/auth/')) {
      if (p === '/auth/tiktok/login' && req.method === 'GET') {
        const d = await getDb();
        if (!tiktok.isConfigured()) return send(res, 503, { error: 'TikTok is not connected yet — set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET on the server, then try again.' });
        if (!requireCoordinatorFlexible(d, req, u)) return send(res, 401, { error: 'Coordinator login required' });
        const client = d.clients.find((c) => c.id === u.searchParams.get('clientId'));
        if (!client) return send(res, 404, { error: 'Client not found' });
        const state = crypto.randomBytes(32).toString('hex');
        d.tiktokOauthStates.push({ state, clientId: client.id, createdAt: new Date().toISOString() });
        d.tiktokOauthStates = d.tiktokOauthStates.filter((s) => Date.now() - new Date(s.createdAt).getTime() < 15 * 60 * 1000);
        await putDb(d);
        const url = tiktok.buildAuthUrl({ clientKey: process.env.TIKTOK_CLIENT_KEY, redirectUri: tiktokRedirectUri(req), state });
        res.writeHead(302, { Location: url });
        return res.end();
      }
      if (p === '/auth/tiktok/callback' && req.method === 'GET') {
        const d = await getDb();
        const tErr = u.searchParams.get('error');
        if (tErr) return oauthPage(res, 400, 'TikTok connection cancelled', `TikTok reported: ${(u.searchParams.get('error_description') || tErr).replace(/[<>&]/g, '')}`, false);
        if (!tiktok.isConfigured()) return oauthPage(res, 503, 'TikTok is not connected', 'The server is missing TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET. Set them, then start the connection again from the coordinator desk.', false);
        const state = u.searchParams.get('state') || '';
        const code = u.searchParams.get('code') || '';
        const rec = d.tiktokOauthStates.find((s) => {
          try { return s.state.length === state.length && crypto.timingSafeEqual(Buffer.from(s.state, 'utf8'), Buffer.from(state, 'utf8')); }
          catch { return false; }
        });
        // States are single-use and expire after 15 minutes.
        d.tiktokOauthStates = d.tiktokOauthStates.filter((s) => s !== rec && Date.now() - new Date(s.createdAt).getTime() < 15 * 60 * 1000);
        await putDb(d);
        if (!rec) return oauthPage(res, 400, 'Login session invalid or expired', 'Please start the TikTok connection again from the coordinator desk.', false);
        const client = d.clients.find((c) => c.id === rec.clientId);
        if (!client) return oauthPage(res, 400, 'Client not found', 'The client this connection was started for no longer exists.', false);
        let tok;
        try { tok = await tiktok.exchangeCode({ code, redirectUri: tiktokRedirectUri(req) }); }
        catch (e) { return oauthPage(res, 502, 'TikTok would not issue a token', String(e.message || e).replace(/[<>&]/g, ''), false); }
        try {
          const key = tiktok.deriveVaultKey(d);
          const next = tiktok.buildVaultRecord({ clientId: client.id, network: 'tiktok', tokenJson: tok, key });
          d.tiktokTokens = d.tiktokTokens.filter((t) => !(t.clientId === client.id && t.network === 'tiktok'));
          d.tiktokTokens.push(next);
          audit(d, client.id, 'tiktok_connected', `TikTok account connected for ${client.name}`);
          await putDb(d);
        } catch (e) { return oauthPage(res, 500, 'Could not save the TikTok connection', String(e.message || e).replace(/[<>&]/g, ''), false); }
        return oauthPage(res, 200, 'TikTok connected', `This client's TikTok account is connected. You can close this tab and return to the coordinator desk.`, true);
      }
      // TikTok URL-verification signature files may live under the callback
      // path (one per URL property). Serve .txt files there as static text
      // instead of falling into the 404 below.
      if (p.startsWith('/auth/tiktok/callback/') && p.endsWith('.txt') && req.method === 'GET') {
        const fp = path.join(__dirname, 'public', p);
        if (fp.startsWith(path.join(__dirname, 'public') + path.sep) && fs.existsSync(fp)) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return fs.createReadStream(fp).pipe(res);
        }
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (!p.startsWith('/api/')) {
      // Two doors, one backend: '/' is the coordinator-only desk, '/client'
      // is the client-only page. Both share the same record and /api/* routes.
      // '/terms' and '/privacy' serve the public policy pages (required by the
      // networks' developer programs).
      let file = p === '/' ? '/index.html' : p === '/client' ? '/client.html' : p === '/desk' ? '/desk.html' : p === '/terms' ? '/terms.html' : p === '/privacy' ? '/privacy.html' : p;
      const fp = path.join(__dirname, 'public', file);
      if (!fp.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(fp);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      return fs.createReadStream(fp).pipe(res);
    }
    const d = await getDb();
    const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`;

    if (p === '/api/health') return send(res, 200, { ok: true, storage: process.env.DATABASE_URL ? 'postgres' : 'json-file', clients: d.clients.length, version: versionBadge() });
    if (p === '/api/setup' && req.method === 'POST') {
      if (d.coordinator) return send(res, 400, { error: 'Coordinator already set up' });
      const b = await body(req);
      if (!b.password || b.password.length < 4) return send(res, 400, { error: 'Choose a password of at least 4 characters' });
      const salt = crypto.randomBytes(16).toString('hex');
      d.coordinator = { salt, hash: hashPassword(b.password, salt) };
      await putDb(d);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/status') return send(res, 200, { coordinatorSetUp: !!d.coordinator, version: versionBadge() });
    // TikTok connection status for one client (coordinator only). Never
    // returns tokens or secrets — only whether they exist and when they expire.
    if (p === '/api/tiktok/status' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const rec = tiktok.findVaultRecord(d.tiktokTokens, u.searchParams.get('clientId'), 'tiktok');
      return send(res, 200, {
        configured: tiktok.isConfigured(),
        connected: !!rec,
        openId: rec ? rec.openId : null,
        expiresAt: rec ? rec.expiresAt : null,
      });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      if (!d.coordinator || hashPassword(b.password || '', d.coordinator.salt) !== d.coordinator.hash) return send(res, 401, { error: 'Wrong password' });
      const token = uid();
      d.coordinatorTokens.push({ token, createdAt: new Date().toISOString() });
      await putDb(d);
      return send(res, 200, { token });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = requireCoordinator(d, req);
      if (t) { d.coordinatorTokens = d.coordinatorTokens.filter((x) => x.token !== t); await putDb(d); }
      return send(res, 200, { ok: true });
    }

    // ---------- BCB AI: batch jobs + results (Sophia wrapper, F1) ----------
    // Batch mode: the coordinator enqueues a job; the app-side poller
    // (runWrapperJob, above) submits it to the deployed wrapper's
    // POST /v1/batch and polls GET /v1/batch/:id to a terminal state,
    // then ingests the result through the same validation + guards as
    // the HTTP ingest endpoint. The old direct `claude -p` runner is
    // RETIRED (see ~/workspace/sophia-ai-build/bcb-batch/README.md).
    // POST /api/ai/jobs/:id/result (Bearer BCB_AI_TOKEN) remains as the
    // ingest door for results posted back from outside the poller.
    // Live mode: /api/videos/:id/reply can be served synchronously
    // through the wrapper's /v1/chat when configured — see lib/ai.js.
    // Nothing here calls a model, Muse, or a paid API directly.
    if (p === '/api/coordinator/ai/jobs' && req.method === 'POST') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const b = await body(req);
      const type = b.type;
      if (!['plan_video', 'playbook', 'network_watch', 'niche_check', 'draft_reply'].includes(type)) return send(res, 400, { error: 'Unknown AI job type' });
      const video = b.videoId ? d.videos.find((v) => v.id === b.videoId) : null;
      if (b.videoId && !video) return send(res, 404, { error: 'Video not found' });
      const clientId = (video && video.clientId) || b.clientId || null;
      const context = buildJobContext(d, { videoId: b.videoId || null, clientId });
      const job = { id: uid(), type, videoId: b.videoId || null, clientId, payload: { ...context, ...(b.payload || {}) }, status: 'queued', result: null, error: null, createdAt: new Date().toISOString(), completedAt: null };
      d.aiJobs.push(job);
      audit(d, job.clientId, 'ai_job_queued', `AI batch job queued: ${type}${video ? ` for "${video.title}"` : ''}`);
      await putDb(d);
      kickWrapperJob(job.id);
      return send(res, 200, { job });
    }
    if (p === '/api/coordinator/ai/jobs' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const list = d.aiJobs.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return send(res, 200, { jobs: list });
    }
    const jm = p.match(/^\/api\/coordinator\/ai\/jobs\/([^/]+)$/);
    if (jm && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const job = d.aiJobs.find((x) => x.id === jm[1]);
      if (!job) return send(res, 404, { error: 'AI job not found' });
      return send(res, 200, { job });
    }
    // Batch-result ingest — the door back into the app for results
    // posted from outside the wrapper-batch poller. Token-authenticated
    // with BCB_AI_TOKEN (shared secret, set on the host — never in the
    // repo). Fails closed (503) when the secret is not set on the
    // server, 401 on a wrong token. Validation + DO-NOT-SEND + empty
    // guards live in ingestJobResult (shared with the poller).
    const rm = p.match(/^\/api\/ai\/jobs\/([^/]+)\/result$/);
    if (rm && req.method === 'POST') {
      if (!ai.AI_TOKEN) return send(res, 503, { error: 'AI result ingest is not configured — set BCB_AI_TOKEN on the server' });
      const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!t || t !== ai.AI_TOKEN) return send(res, 401, { error: 'Invalid AI ingest token' });
      const job = d.aiJobs.find((x) => x.id === rm[1]);
      if (!job) return send(res, 404, { error: 'AI job not found' });
      const b = await body(req);
      ingestJobResult(d, job, { status: b.status, result: b.result, error: b.error });
      await putDb(d);
      return send(res, 200, { job });
    }
    // MCP dispatch receiver (F2) — the foundation wrapper's dispatch
    // target for bcb.* tools. Register this URL per tool in
    // /opt/sophia/foundation/config.json "app_servers", e.g.
    //   "bcb.plan_video": {"url": "https://<app-host>/api/ai/mcp/bcb.plan_video"}
    // Auth (defect (g)): the foundation's service_token must equal
    // SOPHIA_SERVICE_TOKEN (sent as X-Sophia-Token; Bearer is also
    // accepted). That is a DIFFERENT secret from BCB_AI_TOKEN, which is
    // the batch-ingest secret only — the two are never the same value.
    // Fails closed (503) when SOPHIA_SERVICE_TOKEN is not set on the
    // server. Batchable tools enqueue an aiJob with the SAME context
    // enrichment as coordinator jobs (defect (j)) and return
    // {status:"queued", jobId} — the wrapper-batch poller picks the job
    // up; nothing here pretends to have acted. Gated tools answer
    // {status:"gated"} honestly until their adapters exist.
    // NOTE (Wave 1B): on app HTTP errors the wrapper discards the app's
    // explanatory body and returns only the status code — keep error
    // bodies informative for direct callers, but do not rely on the
    // wrapper to relay them.
    const mm = p.match(/^\/api\/ai\/mcp\/(bcb\.[a-z_]+)$/);
    if (mm && req.method === 'POST') {
      if (!ai.SERVICE_TOKEN) return send(res, 503, { error: 'MCP dispatch is not configured — set SOPHIA_SERVICE_TOKEN on the server (must equal the wrapper service_token)' });
      const t = (req.headers['x-sophia-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!t || t !== ai.SERVICE_TOKEN) return send(res, 401, { error: 'Invalid MCP dispatch token' });
      const tool = mm[1];
      const b = await body(req);
      const enqueue = (type, videoId, clientId, payload) => {
        const job = { id: uid(), type, videoId: videoId || null, clientId: clientId || null, payload: payload || {}, status: 'queued', result: null, error: null, createdAt: new Date().toISOString(), completedAt: null };
        d.aiJobs.push(job);
        audit(d, clientId, 'ai_job_queued', `AI batch job queued via MCP ${tool}: ${type}`);
        return job;
      };
      if (tool === 'bcb.plan_video') {
        if (!b.client_id || !b.brief) return send(res, 400, { error: 'client_id and brief are required' });
        const context = buildJobContext(d, { videoId: b.video_id || null, clientId: b.client_id });
        const job = enqueue('plan_video', b.video_id || null, b.client_id, { ...context, brief: b.brief, niche: (context.lockedNiche && context.lockedNiche.niche) || b.niche || null });
        await putDb(d);
        kickWrapperJob(job.id);
        return send(res, 200, { status: 'queued', jobId: job.id, tool });
      }
      if (tool === 'bcb.draft_reply') {
        if (!b.video_id || !b.comment_text) return send(res, 400, { error: 'video_id and comment_text are required' });
        const video = d.videos.find((v) => v.id === b.video_id);
        if (!video) return send(res, 404, { error: 'Video not found' });
        const context = buildJobContext(d, { videoId: video.id, clientId: video.clientId });
        const nicheCheck = ai.nichePreCheck({ video, niche: context.lockedNiche });
        const job = enqueue('draft_reply', video.id, video.clientId, { ...context, niche: context.lockedNiche, comment: b.comment_text, commenter: b.commenter || '', nicheCheck });
        await putDb(d);
        kickWrapperJob(job.id);
        return send(res, 200, { status: 'queued', jobId: job.id, tool });
      }
      if (tool === 'bcb.niche_check') {
        if (!b.client_id) return send(res, 400, { error: 'client_id is required' });
        const video = b.video_id ? d.videos.find((v) => v.id === b.video_id) : null;
        if (b.video_id && !video) return send(res, 404, { error: 'Video not found' });
        const context = buildJobContext(d, { videoId: video ? video.id : null, clientId: b.client_id });
        const job = enqueue('niche_check', video ? video.id : null, b.client_id, { ...context, script: b.script || null });
        await putDb(d);
        kickWrapperJob(job.id);
        return send(res, 200, { status: 'queued', jobId: job.id, tool });
      }
      if (tool === 'bcb.queue_generation') {
        return send(res, 200, { status: 'gated', tool, message: 'Video generation is gated: no paid video-model adapter (F6) and no spend approval exist. Nothing was queued.' });
      }
      if (tool === 'bcb.publish') {
        // Wave 2D: creates per-platform publish records (Buffer state
        // machine) — scheduled at the requested time, or now. The
        // worker attempts them at due time; with zero adapters
        // enabled every platform refuses honestly and the failure
        // lands on the record. Nothing here posts to a real platform.
        // per_post_approval clients land in needs_approval until the
        // coordinator approves them from the desk.
        if (!b.video_id || !Array.isArray(b.platforms) || !b.platforms.length) return send(res, 400, { error: 'video_id and platforms[] are required' });
        const bad = b.platforms.filter((pl) => !publish.PLATFORMS.includes(pl));
        if (bad.length) return send(res, 400, { error: `Unknown platform(s): ${bad.join(', ')} — use ${publish.PLATFORMS.join(', ')}` });
        const video = d.videos.find((v) => v.id === b.video_id);
        if (!video) return send(res, 404, { error: 'Video not found' });
        const client = d.clients.find((c) => c.id === video.clientId);
        const needsApproval = client && client.approvalMode === 'per_post_approval';
        const scheduledFor = b.schedule || (video.schedule && video.schedule[b.platforms[0]]) || null;
        video.publish = video.publish || {};
        const per = {};
        for (const pl of b.platforms) {
          const rec = publish.newPublishRecord(pl, { scheduledFor, status: needsApproval ? 'needs_approval' : 'scheduled' });
          video.publish[pl] = rec;
          per[pl] = { status: rec.status, idempotencyKey: rec.idempotencyKey, scheduledFor: rec.scheduledFor };
        }
        audit(d, video.clientId, 'publish_queued', `Publish queued via MCP ${tool} for "${video.title}" on ${b.platforms.join(', ')} (${needsApproval ? 'needs approval' : 'scheduled'}) — adapters are not enabled, so the worker will refuse honestly until Michael enables each platform`);
        await putDb(d);
        return send(res, 200, { status: 'queued', tool, videoId: video.id, platforms: per, note: 'Publish records created. No platform adapter is enabled yet — the worker refuses honestly at publish time until Michael gives the per-platform go-ahead (TikTok first).' });
      }
      return send(res, 404, { error: 'Unknown MCP tool' });
    }
    if (p === '/api/coordinator/ai/plans' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      let plans = d.aiPlans.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const vid = u.searchParams.get('videoId');
      if (vid) plans = plans.filter((x) => x.videoId === vid);
      return send(res, 200, { plans });
    }
    if (p === '/api/coordinator/ai/playbooks' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      let pbs = d.aiPlaybooks.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const cid = u.searchParams.get('clientId');
      if (cid) pbs = pbs.filter((x) => x.clientId === cid);
      return send(res, 200, { playbooks: pbs });
    }
    if (p === '/api/coordinator/ai/watch' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const watch = d.aiWatch.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return send(res, 200, { watch, freshness: feedFreshness(d.aiWatch) });
    }
    if (p === '/api/coordinator/ai/status' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      return send(res, 200, {
        wrapperConfigured: ai.isWrapperConfigured(),
        ingestConfigured: !!ai.AI_TOKEN,
        mode: ai.isWrapperConfigured() ? 'live-via-wrapper' : 'batch-only',
        counts: { jobs: d.aiJobs.length, queued: d.aiJobs.filter((j) => j.status === 'queued').length, plans: d.aiPlans.length, playbooks: d.aiPlaybooks.length, watch: d.aiWatch.length },
        mcpTools: ai.MCP_TOOLS.map((t) => t.name),
        portableTokens: {
          enabled: portableTokens.isPortableTokensEnabled(),
          count: (d.portableTokens || []).length,
          active: (d.portableTokens || []).filter((t) => t.status === 'active').length,
          note: 'Step 3, code only: issuance is off unless BCB_PORTABLE_TOKENS_ENABLED=1, and the wrapper still needs its verification-side change before an issued token can authenticate a live call (docs/token-portability.md).',
        },
        note: ai.isWrapperConfigured()
          ? 'Live wrapper configured — reply drafts can be served synchronously; batch jobs go through the wrapper batch poller.'
          : 'Batch only: the wrapper is deployed, not configured on Render — set SOPHIA_WRAPPER_URL, SOPHIA_WRAPPER_TOKEN and SOPHIA_WRAPPER_CA_PEM on the host to enable live replies and wrapper batch jobs.',
      });
    }
    // ---------- Portable tokens, step 3 (code only) ----------
    // Issuance, not extraction (research report §0.5): per-client
    // scoped tokens, shown once via a one-time pop handoff, hash-only
    // stored, short-lived access (60 min) + rotating one-time refresh
    // (30 days), back-channel refresh, immediate revocation.
    // OFF by default — every route below fails closed 503 unless
    // BCB_PORTABLE_TOKENS_ENABLED=1 is set on the host. No route here
    // ever returns a hash or a plaintext except the single pop, and
    // no token is ever accepted in a query string (400).
    // The wrapper does NOT verify these yet (VPS-side follow-up in
    // docs/token-portability.md) — issuing one does not make a live
    // call work until that lands.
    const portableDisabled = () => send(res, 503, { error: 'Portable token issuance is not enabled — set BCB_PORTABLE_TOKENS_ENABLED=1 on the host to enable it (code only until the wrapper learns to verify these tokens)' });
    if (p === '/api/coordinator/portable-tokens' && req.method === 'POST') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      if (!portableTokens.isPortableTokensEnabled()) return portableDisabled();
      const b = await body(req);
      const client = b.clientId ? d.clients.find((c) => c.id === b.clientId) : null;
      if (!client) return send(res, 404, { error: 'Client not found — portable tokens are issued per client, one token per client' });
      let minted;
      try { minted = portableTokens.mintPortableToken({ clientId: client.id, name: b.name, scopes: b.scopes }); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      await updateDb((dd) => {
        if (!dd.portableTokens.find((r) => r.id === minted.record.id)) dd.portableTokens.push(minted.record);
        audit(dd, client.id, 'portable_token_issued', `Portable token issued for ${client.name} (${minted.record.id}, scopes ${minted.record.scopes.join(', ')}) — shown once via handoff, hash only stored`);
        return minted.record;
      });
      const handoffId = portableHandoffs.create({ accessToken: minted.issued.accessToken, refreshToken: minted.issued.refreshToken });
      return send(res, 200, {
        token: portableTokens.publicToken(minted.record),
        handoffId,
        handoffExpiresInSeconds: portableTokens.HANDOFF_TTL_MS / 1000,
        note: 'Shown once: pop the handoff (POST /api/coordinator/portable-tokens/handoff/:id/pop) to see the values, then paste them into Render env vars (SOPHIA_WRAPPER_TOKEN / SOPHIA_WRAPPER_REFRESH_TOKEN). The server stores only hashes and cannot show them again — if lost, revoke this token and re-issue.',
      });
    }
    if (p === '/api/coordinator/portable-tokens' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      if (!portableTokens.isPortableTokensEnabled()) return portableDisabled();
      return send(res, 200, { tokens: portableTokens.listPortableTokens(d.portableTokens || []) });
    }
    const popMatch = p.match(/^\/api\/coordinator\/portable-tokens\/handoff\/([^/]+)\/pop$/);
    if (popMatch && req.method === 'POST') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      if (!portableTokens.isPortableTokensEnabled()) return portableDisabled();
      const value = portableHandoffs.pop(popMatch[1]);
      if (!value) return send(res, 410, { error: 'Handoff already popped or expired — the values are gone. Revoke the token and re-issue if you still need them.' });
      return send(res, 200, { ...value, renderEnv: portableTokens.formatRenderEnvVars(value), note: 'Shown once — this handoff is now deleted at the source. Paste into Render env vars, then close this.' });
    }
    const revokeMatch = p.match(/^\/api\/coordinator\/portable-tokens\/([^/]+)\/revoke$/);
    if (revokeMatch && req.method === 'POST') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      if (!portableTokens.isPortableTokensEnabled()) return portableDisabled();
      const b = await body(req);
      const { result: rec } = await updateDb((dd) => {
        const r = portableTokens.revokePortableToken(dd.portableTokens || [], revokeMatch[1], b.reason || 'revoked by coordinator');
        if (!r) throw Object.assign(new Error('Portable token not found'), { statusCode: 404 });
        audit(dd, r.clientId, 'portable_token_revoked', `Portable token revoked (${r.id}) — ${r.revokedReason}`);
        return r;
      }).catch((e) => ({ result: null, _error: e }));
      if (!rec) {
        // updateDb rethrows the mutator error; distinguish 404 from a
        // real failure by re-checking the stored record.
        const stored = (d.portableTokens || []).find((r) => r.id === revokeMatch[1]);
        if (!stored) return send(res, 404, { error: 'Portable token not found' });
        return send(res, 500, { error: 'Could not revoke the token — try again' });
      }
      return send(res, 200, { token: portableTokens.publicToken(rec) });
    }
    // Back-channel refresh (server-to-server only): POST the refresh
    // token in the JSON body — never in a query string, never in a
    // header, never through a browser. Returns a NEW access + refresh
    // pair, shown once; the old access token stops verifying at once
    // and the old refresh token can never be used again (replaying it
    // revokes the whole family).
    if (p === '/api/tokens/refresh' && req.method === 'POST') {
      if (!portableTokens.isPortableTokensEnabled()) return portableDisabled();
      if (portableTokens.tokenInQuery(Object.fromEntries(u.searchParams.entries()))) {
        return send(res, 400, { error: 'Tokens are never accepted in a query string — send the refresh token in the JSON body' });
      }
      const b = await body(req);
      if (!b.refreshToken || typeof b.refreshToken !== 'string') return send(res, 400, { error: 'refreshToken is required in the JSON body' });
      const { result } = await updateDb((dd) => {
        const out = portableTokens.rotateRefreshToken(dd.portableTokens || [], b.refreshToken);
        if (out.ok) {
          audit(dd, out.record.clientId, 'portable_token_rotated', `Portable token rotated (${out.record.id}) — new access + refresh issued, old access invalidated`);
        } else if (out.familyRevoked) {
          audit(dd, out.record ? out.record.clientId : null, 'portable_token_family_revoked', `Portable token family revoked (${out.record ? out.record.id : 'unknown'}) — a used refresh token was replayed`);
        }
        return out;
      });
      if (!result.ok) return send(res, result.status || 401, { error: result.code, familyRevoked: !!result.familyRevoked });
      return send(res, 200, {
        accessToken: result.issued.accessToken,
        refreshToken: result.issued.refreshToken,
        expiresInSeconds: portableTokens.ACCESS_TTL_MS / 1000,
        token: portableTokens.publicToken(result.record),
        note: 'Shown once — store both values in Render env vars now. The old access token no longer verifies.',
      });
    }
    // ---------- Publish worker + token health (Wave 2D) ----------
    // The scheduler is a VPS cron hitting these worker endpoints
    // (Render free sleeps, so the app cannot wake itself). Worker
    // auth: BCB_WORKER_TOKEN (Bearer or X-Worker-Token), fails closed
    // 503 when unset, 401 on a wrong token. The worker never posts to
    // a real platform while its adapter is disabled — every platform
    // refuses honestly and the failure lands on the record.
    const requireWorker = (req) => {
      if (!WORKER_TOKEN) return { error: 503, message: 'Worker endpoints are not configured — set BCB_WORKER_TOKEN on the server' };
      const t = (req.headers['x-worker-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!t || t !== WORKER_TOKEN) return { error: 401, message: 'Invalid worker token' };
      return { ok: true };
    };
    if (p === '/api/worker/publish/run' && req.method === 'POST') {
      const w = requireWorker(req);
      if (!w.ok) return send(res, w.error, { error: w.message });
      const d = await getDb();
      const now = Date.now();
      const summary = { attempted: 0, sent: 0, failed: 0, errored: 0, outcomes: [] };
      for (const video of d.videos) {
        const outcomes = await processDuePublishesForVideo(d, video, now);
        for (const o of outcomes) {
          summary.attempted += 1;
          if (o.outcome === 'sent') summary.sent += 1;
          else if (o.outcome === 'failed') summary.failed += 1;
          else summary.errored += 1;
          summary.outcomes.push({ videoId: video.id, platform: o.platform, outcome: o.outcome, kind: o.kind });
        }
      }
      await putDb(d);
      return send(res, 200, { ok: true, ...summary });
    }
    // Token sweep (layer 1): hourly. Refreshes TikTok tokens near
    // expiry (row-locked per client+platform — TikTok rotation rule);
    // marks dead records EXPIRED with their publish records FAILED +
    // Reconnect. YouTube/Instagram/Facebook have no refresh path
    // until their adapters exist — expiring records there are
    // reported, never pretended refreshed.
    if (p === '/api/worker/tokens/sweep' && req.method === 'POST') {
      const w = requireWorker(req);
      if (!w.ok) return send(res, w.error, { error: w.message });
      const d = await getDb();
      const all = [...(d.tiktokTokens || []), ...(d.platformTokens || [])];
      const { toRefresh, expired } = tokens.sweepTokenRecords(all);
      const refreshed = [];
      const refreshFailed = [];
      const unavailable = [];
      for (const { record } of toRefresh) {
        if (record.network !== 'tiktok') { unavailable.push({ clientId: record.clientId, platform: record.network, reason: 'no refresh path until the platform adapter exists' }); continue; }
        if (!tokens.acquireRefreshLock(record.clientId, 'tiktok')) { unavailable.push({ clientId: record.clientId, platform: 'tiktok', reason: 'refresh already in progress for this account — skipped this sweep' }); continue; }
        try {
          const got = await getValidTiktokToken(d, record.clientId);
          if (got) refreshed.push({ clientId: record.clientId, platform: 'tiktok' });
          else refreshFailed.push({ clientId: record.clientId, platform: 'tiktok', reason: 'no token record to refresh' });
        } catch (e) {
          refreshFailed.push({ clientId: record.clientId, platform: 'tiktok', reason: String(e.message || e) });
          tokens.markAccountExpired(d, record.clientId, 'tiktok', String(e.message || e));
          audit(d, record.clientId, 'token_expired', `TikTok account marked EXPIRED: ${String(e.message || e)} — reconnect required`);
        } finally {
          tokens.releaseRefreshLock(record.clientId, 'tiktok');
        }
      }
      const markedExpired = [];
      for (const rec of expired) {
        if (rec.status === 'expired' && rec.expiredAt) continue; // already marked
        const r = tokens.markAccountExpired(d, rec.clientId, rec.network, `access token expired at ${rec.expiresAt || 'unknown time'} and refresh failed or was not attempted`);
        markedExpired.push({ clientId: rec.clientId, platform: rec.network, recordsFailed: r.recordsFailed });
        audit(d, rec.clientId, 'token_expired', `${rec.network} account marked EXPIRED — reconnect required`);
      }
      await putDb(d);
      return send(res, 200, { ok: true, checked: all.length, toRefresh: toRefresh.length, refreshed, refreshFailed, unavailable, alreadyExpired: expired.length, markedExpired });
    }
    // Token health overview for the desk (coordinator only). Never
    // returns token values — only whether they exist, when they
    // expire, and what to do (Reconnect chip when EXPIRED).
    if (p === '/api/coordinator/tokens' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const all = [...(d.tiktokTokens || []).map((r) => ({ ...r, source: 'tiktok' })), ...(d.platformTokens || []).map((r) => ({ ...r, source: 'platform' }))];
      const list = all.map((r) => {
        const h = tokens.tokenHealth(r);
        const client = d.clients.find((c) => c.id === r.clientId);
        return { clientId: r.clientId, clientName: client ? client.name : null, platform: r.network, connected: true, openId: r.openId || null, scope: r.scope || null, expiresAt: r.expiresAt || null, refreshExpiresAt: r.refreshExpiresAt || null, status: h.status, action: h.action, reason: h.reason || null, reconnect: h.status === 'expired' ? tokens.reconnectInfo(r.network) : null };
      });
      return send(res, 200, { tokens: list, lifetimes: tokens.PLATFORM_TOKEN_LIFETIMES });
    }
    // ---------- Coordinator desk (Wave 2C) ----------
    // One aggregate read for the desk UI (/desk): SLA queue, replies with
    // their state-machine status, AI jobs, versioned plans, and the
    // trend feed with its freshness stamp. Every view shows honest
    // state — queued/running/done/failed/gated, never a fake. Nothing
    // here invents a status: a missing value is shown as missing.
    if (p === '/api/coordinator/desk' && req.method === 'GET') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const now = Date.now();
      const clientName = (id) => { const c = d.clients.find((x) => x.id === id); return c ? c.name : null; };
      const videoTitle = (id) => { const v = d.videos.find((x) => x.id === id); return v ? v.title : null; };
      const videos = d.videos.map((v) => ({ ...v, clientName: clientName(v.clientId), sla: slaInfo(v, now), firstHour: comments.firstHourInfo(v, now), publish: publish.publishSummary(v) }))
        .sort((a, b) => a.sla.msRemainingActive - b.sla.msRemainingActive);
      const replies = d.replies.map((r) => ({ ...r, videoTitle: videoTitle(r.videoId), clientName: clientName((d.videos.find((x) => x.id === r.videoId) || {}).clientId) }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const jobs = d.aiJobs.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const plans = d.aiPlans.map((pl) => ({ ...pl, videoTitle: videoTitle(pl.videoId), clientName: clientName(pl.clientId) }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const playbooks = d.aiPlaybooks.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const watch = d.aiWatch.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      // Wave 2D: publish queue (per-platform records + the dangerous
      // partial-failure state), token health, and comment intake.
      const publishQueue = d.videos.map((v) => ({ videoId: v.id, videoTitle: v.title, clientName: clientName(v.clientId), ...publish.publishSummary(v) }))
        .filter((s) => s.platforms.length > 0);
      const tokenList = [...(d.tiktokTokens || []), ...(d.platformTokens || [])].map((r) => {
        const h = tokens.tokenHealth(r);
        return { clientId: r.clientId, clientName: clientName(r.clientId), platform: r.network, expiresAt: r.expiresAt || null, status: h.status, action: h.action, reason: h.reason || null, reconnect: h.status === 'expired' ? tokens.reconnectInfo(r.network) : null };
      });
      const webhookEvents = (d.webhookEvents || []).slice().sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)).slice(0, 20)
        .map((e) => ({ ...e, videoTitle: videoTitle(e.videoId) }));
      return send(res, 200, {
        videos, replies, jobs, plans, playbooks, watch, publishQueue, tokens: tokenList, webhookEvents,
        portableTokens: portableTokens.listPortableTokens(d.portableTokens || []),
        freshness: feedFreshness(d.aiWatch, now),
        ai: {
          mode: ai.isWrapperConfigured() ? 'live-via-wrapper' : 'batch-only',
          wrapperConfigured: ai.isWrapperConfigured(),
          ingestConfigured: !!ai.AI_TOKEN,
        },
        publish: {
          adaptersEnabled: { tiktok: publish.adapterEnabled('tiktok'), youtube: publish.adapterEnabled('youtube'), instagram: publish.adapterEnabled('instagram'), facebook: publish.adapterEnabled('facebook') },
          note: 'No platform adapter is enabled — the worker refuses honestly until Michael gives the per-platform go-ahead (TikTok first).',
        },
        counts: {
          videos: d.videos.length,
          blocked: d.videos.filter((v) => v.pausedAt).length,
          overdue: videos.filter((v) => v.sla.overdue).length,
          repliesDraft: d.replies.filter((r) => r.status === 'draft').length,
          jobsQueued: d.aiJobs.filter((j) => j.status === 'queued').length,
          jobsRunning: d.aiJobs.filter((j) => j.status === 'running').length,
          jobsFailed: d.aiJobs.filter((j) => j.status === 'failed').length,
          plansDraft: d.aiPlans.filter((x) => x.status === 'draft').length,
          publishFailed: publishQueue.reduce((n, s) => n + s.failed, 0),
          publishPartialFailure: publishQueue.filter((s) => s.partialFailure).length,
          tokensExpired: tokenList.filter((t) => t.status === 'expired').length,
          portableTokensActive: (d.portableTokens || []).filter((t) => t.status === 'active').length,
          portableTokensRevoked: (d.portableTokens || []).filter((t) => t.status === 'revoked').length,
          webhookNeedsVideo: (d.webhookEvents || []).filter((e) => e.status === 'needs_video').length,
        },
      });
    }
    // ---------- Reply + plan state machines (Wave 2C) ----------
    // Replies: draft -> approved -> posted, or draft/approved -> rejected.
    // Draft-first: nothing posts without coordinator approval. "Posted"
    // here is the coordinator confirming they posted the approved reply
    // themselves (no platform API is wired yet — wave 2D); the record
    // says how it was posted, never that an API posted it.
    const replyAction = p.match(/^\/api\/videos\/([^/]+)\/replies\/([^/]+)\/(approve|reject|post)$/);
    if (replyAction && req.method === 'POST') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const action = replyAction[3];
      const b = await body(req);
      try {
        const { result: reply } = await updateDb((dd) => {
          const r = dd.replies.find((x) => x.id === replyAction[2] && x.videoId === replyAction[1]);
          if (!r) throw Object.assign(new Error('Reply not found'), { statusCode: 404 });
          const nowIso = new Date().toISOString();
          if (action === 'approve') {
            if (r.status !== 'draft') throw Object.assign(new Error(`Cannot approve a reply in status "${r.status}" — only a draft can be approved`), { statusCode: 400 });
            r.status = 'approved'; r.statusAt = nowIso;
          } else if (action === 'reject') {
            if (r.status !== 'draft' && r.status !== 'approved') throw Object.assign(new Error(`Cannot reject a reply in status "${r.status}" — only a draft or approved reply can be rejected`), { statusCode: 400 });
            r.status = 'rejected'; r.statusAt = nowIso; r.rejectionReason = b.reason || '';
          } else {
            if (r.status !== 'approved') throw Object.assign(new Error(`Cannot mark posted: reply is "${r.status}" — only an approved reply can be marked posted`), { statusCode: 400 });
            r.status = 'posted'; r.statusAt = nowIso; r.postedAt = nowIso; r.postedChannel = b.channel || 'manual';
          }
          const v = dd.videos.find((x) => x.id === r.videoId);
          audit(dd, v ? v.clientId : null, 'reply_' + r.status, `Reply ${r.status}: "${String(r.text || '').slice(0, 80)}"${r.rejectionReason ? ` — ${r.rejectionReason}` : ''}`);
          return r;
        });
        return send(res, 200, { reply });
      } catch (e) {
        return send(res, e.statusCode || 500, { error: String(e.message || e) });
      }
    }
    // Plans: approve a draft version (supersedes any previously approved
    // version for the same video) or reject it with a reason. A new
    // version never silently overwrites an approved plan — approval is
    // the explicit step that retires the old approved version.
    const planAction = p.match(/^\/api\/coordinator\/ai\/plans\/([^/]+)\/(approve|reject)$/);
    if (planAction && req.method === 'POST') {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const action = planAction[2];
      const b = await body(req);
      try {
        const { result: plan } = await updateDb((dd) => {
          const pl = dd.aiPlans.find((x) => x.id === planAction[1]);
          if (!pl) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
          const nowIso = new Date().toISOString();
          if (action === 'approve') {
            if (pl.status !== 'draft') throw Object.assign(new Error(`Cannot approve a plan in status "${pl.status}" — only a draft version can be approved`), { statusCode: 400 });
            for (const s of dd.aiPlans) {
              if (s.videoId === pl.videoId && s.id !== pl.id && s.status === 'approved') { s.status = 'superseded'; s.supersededBy = pl.id; }
            }
            pl.status = 'approved'; pl.statusAt = nowIso;
          } else {
            if (pl.status !== 'draft') throw Object.assign(new Error(`Cannot reject a plan in status "${pl.status}" — only a draft version can be rejected`), { statusCode: 400 });
            pl.status = 'rejected'; pl.statusAt = nowIso; pl.rejectionReason = b.reason || '';
          }
          audit(dd, pl.clientId, 'plan_' + pl.status, `Plan v${pl.version} ${pl.status}: "${String(pl.title || '').slice(0, 80)}"${pl.rejectionReason ? ` — ${pl.rejectionReason}` : ''}`);
          return pl;
        });
        return send(res, 200, { plan });
      } catch (e) {
        return send(res, e.statusCode || 500, { error: String(e.message || e) });
      }
    }

    // Coordinator routes
    if (p.startsWith('/api/coordinator/')) {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      if (p === '/api/coordinator/clients' && req.method === 'GET') {
        let list = d.clients.map((c) => clientView(d, c));
        const q = (u.searchParams.get('search') || '').toLowerCase();
        if (q) list = list.filter((c) => [c.name, c.email, c.phone, String(c.accountNumber)].join(' ').toLowerCase().includes(q));
        const sort = u.searchParams.get('sort') || 'name';
        list.sort((a, b) => sort === 'recent' ? (b.createdAt < a.createdAt ? -1 : 1) : String(a.name).localeCompare(String(b.name)));
        return send(res, 200, { clients: list });
      }
      if (p === '/api/coordinator/clients' && req.method === 'POST') {
        const b = await body(req);
        if (!b.name || !b.email) return send(res, 400, { error: 'Client name and email are required' });
        const accountNumber = pickAccountNumber(d.clients.map((c) => c.accountNumber));
        const client = { id: uid(), name: b.name, email: b.email, phone: b.phone || '', approvalMode: b.approvalMode === 'per_post_approval' ? 'per_post_approval' : 'professional_default', accountNumber, createdAt: new Date().toISOString() };
        d.clients.push(client);
        const code = { id: uid(), clientId: client.id, code: makeCode(), expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), opens: 0, lastOpenedAt: null, revoked: false, sentAt: null, sentChannel: null };
        d.codes.push(code);
        audit(d, client.id, 'client_created', `Client ${client.name} created — account #${accountNumber}, code issued`);
        await putDb(d);
        return send(res, 200, { client: clientView(d, client), code, message: fullMessage(client, code, baseUrl), mailto: mailtoLink(client, code, baseUrl), sms: client.phone ? smsLink(client, code, baseUrl) : null });
      }
      const m = p.match(/^\/api\/coordinator\/clients\/([^/]+)\/(send|revoke|niche|preview)$/);
      if (m) {
        const client = d.clients.find((c) => c.id === m[1]);
        if (!client) return send(res, 404, { error: 'Client not found' });
        if (m[2] === 'send' && req.method === 'POST') {
          const b = await body(req);
          const code = d.codes.find((x) => x.clientId === client.id && !x.revoked && new Date(x.expiresAt) > new Date());
          if (!code) return send(res, 400, { error: 'No active code for this client' });
          code.sentAt = new Date().toISOString(); code.sentChannel = b.channel || 'email';
          audit(d, client.id, 'code_sent', `Magic-link code marked sent via ${code.sentChannel} to ${b.channel === 'text' ? client.phone : client.email}`);
          await putDb(d);
          return send(res, 200, { client: clientView(d, client), code, message: fullMessage(client, code, baseUrl), mailto: mailtoLink(client, code, baseUrl), sms: client.phone ? smsLink(client, code, baseUrl) : null });
        }
        if (m[2] === 'revoke' && req.method === 'POST') {
          d.codes.filter((x) => x.clientId === client.id).forEach((x) => { x.revoked = true; });
          audit(d, client.id, 'code_revoked', 'All codes revoked by coordinator');
          await putDb(d);
          return send(res, 200, { client: clientView(d, client) });
        }
        if (m[2] === 'niche' && req.method === 'POST') {
          const b = await body(req);
          const niche = { id: uid(), clientId: client.id, niche: b.niche || '', pillars: b.pillars || [], format: b.format || '', promise: b.promise || '', confidence: b.confidence || 'medium', status: 'proposed', version: (d.niches.filter((x) => x.clientId === client.id).length + 1), createdAt: new Date().toISOString(), clientDecision: null, decisionNote: '' };
          d.niches.push(niche);
          audit(d, client.id, 'niche_proposed', `Niche proposal v${niche.version} created: ${niche.niche}`);
          await putDb(d);
          return send(res, 200, { niche });
        }
        if (m[2] === 'preview' && req.method === 'POST') {
          const b = await body(req);
          const code = d.codes.find((x) => x.code === (b.code || '').toUpperCase());
          if (!code || code.revoked || new Date(code.expiresAt) <= new Date()) return send(res, 400, { error: 'That code is not active' });
          return send(res, 200, { clientId: code.clientId, note: 'Preview only — coordinator session is kept separately and is not signed out by opening a client page.' });
        }
      }
      return send(res, 404, { error: 'Not found' });
    }

    // Client code redemption — open on first screen, no login
    if (p === '/api/redeem' && req.method === 'POST') {
      const b = await body(req);
      const code = d.codes.find((x) => x.code === (b.code || '').toUpperCase());
      if (!code || code.revoked || new Date(code.expiresAt) <= new Date()) return send(res, 400, { error: "That code isn't active. Check the code, or ask your coordinator for a new one." });
      code.opens += 1; code.lastOpenedAt = new Date().toISOString();
      const token = uid();
      d.clientTokens.push({ token, clientId: code.clientId, createdAt: new Date().toISOString() });
      audit(d, code.clientId, 'bridge_connected', 'Bridge connected — client code redeemed');
      await putDb(d);
      return send(res, 200, { token, clientId: code.clientId });
    }

    // Client routes (own record only)
    if (p.startsWith('/api/client/')) {
      const s = requireClient(d, req);
      if (!s) return send(res, 401, { error: 'Enter a client code first' });
      const client = d.clients.find((c) => c.id === s.clientId);
      if (!client) return send(res, 404, { error: 'Client not found' });
      if (p === '/api/client/me' && req.method === 'GET') {
        const videos = d.videos.filter((v) => v.clientId === client.id);
        return send(res, 200, {
          client: clientView(d, client),
          portfolio: d.portfolio.filter((x) => x.clientId === client.id),
          niches: d.niches.filter((x) => x.clientId === client.id),
          videos,
          audit: d.audit.filter((x) => x.clientId === client.id),
          report: {
            videos: videos.length,
            byPlatform: ['youtube', 'tiktok', 'instagram', 'facebook'].map((pl) => ({ platform: pl, scheduled: videos.filter((v) => v.schedule && v.schedule[pl]).length })),
          },
        });
      }
      if (p === '/api/client/portfolio' && req.method === 'POST') {
        const b = await body(req);
        const fileIds = Array.isArray(b.fileIds) ? b.fileIds : [];
        for (const fid of fileIds) {
          const f = d.files.find((x) => x.id === fid);
          if (!f || f.client_id !== client.id || f.kind !== 'portfolio') return send(res, 400, { error: 'Invalid attached file' });
        }
        const item = { id: uid(), clientId: client.id, text: b.text || '', links: b.links || '', outcome: b.outcome || '', fileIds, createdAt: new Date().toISOString() };
        d.portfolio.push(item);
        audit(d, client.id, 'portfolio', `Portfolio package sent by client${fileIds.length ? ` (${fileIds.length} file${fileIds.length > 1 ? 's' : ''} attached)` : ''}`);
        await putDb(d);
        return send(res, 200, { item });
      }
      if (p === '/api/client/videos' && req.method === 'POST') {
        const b = await body(req);
        if (!b.title) return send(res, 400, { error: 'Video title is required' });
        const fileIds = Array.isArray(b.fileIds) ? b.fileIds : [];
        for (const fid of fileIds) {
          const f = d.files.find((x) => x.id === fid);
          if (!f || f.client_id !== client.id || !['video', 'thumbnail'].includes(f.kind)) return send(res, 400, { error: 'Invalid attached file' });
        }
        const video = { id: uid(), clientId: client.id, title: b.title, topic: b.topic || '', promise: b.promise || '', links: b.links || '', ctas: b.ctas || '', thumbnailDirection: b.thumbnailDirection || '', thumbnailChoice: b.thumbnailChoice || 'let-us-choose', clipParts: b.clipParts || 'use-best-parts', series: b.series || '', episode: b.episode || '', status: 'step1', intakeCompleteAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(), blockedReason: '', blockedOwner: '', pausedAt: null, pausedMsTotal: 0, schedule: {}, postLinks: {}, createdAt: new Date().toISOString() };
        d.videos.push(video);
        for (const fid of fileIds) { const f = d.files.find((x) => x.id === fid); if (f) f.video_id = video.id; }
        audit(d, client.id, 'video_submitted', `Video submitted: ${video.title} — 3-day clock started${fileIds.length ? ` (${fileIds.length} file${fileIds.length > 1 ? 's' : ''} attached)` : ''}`);
        await putDb(d);
        return send(res, 200, { video });
      }
      const nm = p.match(/^\/api\/client\/niches\/([^/]+)\/decision$/);
      if (nm && req.method === 'POST') {
        const b = await body(req);
        const niche = d.niches.find((x) => x.id === nm[1] && x.clientId === client.id);
        if (!niche) return send(res, 404, { error: 'Niche proposal not found' });
        niche.status = b.decision === 'agree' ? 'agreed' : b.decision === 'override' ? 'overridden' : 'edited';
        niche.clientDecision = b.decision; niche.decisionNote = b.note || '';
        if (b.niche) niche.niche = b.niche;
        audit(d, client.id, 'niche_decision', `Client ${b.decision} niche v${niche.version}`);
        await putDb(d);
        return send(res, 200, { niche });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // File uploads & files — Supabase Storage, direct browser-to-storage.
    // The server never proxies file bytes: it signs URLs, verifies arrivals,
    // and keeps the files ledger. Fails closed (503) when storage env is missing.
    if (p.startsWith('/api/uploads/') || p.startsWith('/api/files') || p === '/api/storage/usage' || p === '/api/admin/purge') {
      const storageDown = (e) => {
        if (e instanceof storage.StorageNotConfiguredError) return send(res, 503, { error: e.message });
        throw e;
      };
      if (p === '/api/uploads/sign' && req.method === 'POST') {
        const who = callerIdentity(d, req);
        if (!who) return send(res, 401, { error: 'Sign in required' });
        const b = await body(req);
        const kind = b.kind;
        if (!['portfolio', 'video', 'thumbnail', 'final'].includes(kind)) return send(res, 400, { error: 'Invalid upload kind' });
        if (kind === 'final' && who.role !== 'coordinator') return send(res, 403, { error: 'Only the coordinator can upload final files' });
        const bytes = Number(b.bytes);
        if (!bytes || bytes <= 0) return send(res, 400, { error: 'File size is required' });
        if (bytes > MAX_FILE_BYTES) return send(res, 400, { error: "Files over 50MB can't upload directly — paste a Google Drive or Dropbox link in the links field instead." });
        const clientId = who.role === 'client' ? who.clientId : b.clientId;
        const client = d.clients.find((c) => c.id === clientId);
        if (!client) return send(res, 404, { error: 'Client not found' });
        let videoId = b.videoId || null;
        if (videoId) {
          const v = d.videos.find((x) => x.id === videoId && x.clientId === client.id);
          if (!v) return send(res, 404, { error: 'Video not found for this client' });
        }
        const filename = sanitizeFilename(b.filename);
        const fileId = uid();
        const spath = `clients/${client.id}/${kind}/${fileId}-${filename}`;
        try {
          const { uploadUrl } = await storage.createUploadUrl(spath, b.mime || 'application/octet-stream');
          d.pendingUploads.push({ fileId, path: spath, clientId: client.id, videoId, kind, filename, mime: b.mime || '', bytes, uploaded_by: who.role, createdAt: new Date().toISOString() });
          d.pendingUploads = d.pendingUploads.filter((x) => Date.now() - new Date(x.createdAt).getTime() < 24 * 3600 * 1000);
          await putDb(d);
          return send(res, 200, { uploadUrl, path: spath, fileId });
        } catch (e) { return storageDown(e); }
      }
      if (p === '/api/uploads/complete' && req.method === 'POST') {
        const who = callerIdentity(d, req);
        if (!who) return send(res, 401, { error: 'Sign in required' });
        const b = await body(req);
        const pend = d.pendingUploads.find((x) => x.fileId === b.fileId);
        if (!pend) return send(res, 404, { error: 'Upload session not found or expired — please upload again' });
        if (who.role === 'client' && pend.clientId !== who.clientId) return send(res, 403, { error: 'Not your upload' });
        if (b.path && b.path !== pend.path) return send(res, 400, { error: 'Upload path mismatch' });
        try {
          const v = await storage.verifyObject(pend.path);
          if (!v.exists) return send(res, 400, { error: 'File did not arrive in storage — please upload again' });
          const now = new Date().toISOString();
          const rec = {
            id: uid(), client_id: pend.clientId, video_id: pend.videoId || null,
            kind: pend.kind, storage_path: pend.path, filename: pend.filename,
            mime: v.mime || pend.mime || '', bytes: v.bytes || pend.bytes,
            uploaded_by: pend.uploaded_by, created_at: now,
            // Video-linked files expire 30 days after publish (set at publish
            // time). Portfolio files expire 90 days after upload.
            expires_at: pend.kind === 'portfolio' ? new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() : null,
          };
          d.files.push(rec);
          d.pendingUploads = d.pendingUploads.filter((x) => x.fileId !== pend.fileId);
          audit(d, pend.clientId, 'file_uploaded', `File uploaded (${pend.kind}): ${pend.filename}`);
          await putDb(d);
          return send(res, 200, { file: rec });
        } catch (e) { return storageDown(e); }
      }
      if (p === '/api/files' && req.method === 'GET') {
        const who = callerIdentity(d, req);
        if (!who) return send(res, 401, { error: 'Sign in required' });
        const clientId = who.role === 'client' ? who.clientId : u.searchParams.get('clientId');
        if (!clientId) return send(res, 400, { error: 'clientId is required' });
        if (!d.clients.some((c) => c.id === clientId)) return send(res, 404, { error: 'Client not found' });
        const videoId = u.searchParams.get('videoId');
        let files = d.files.filter((f) => f.client_id === clientId);
        if (videoId) files = files.filter((f) => f.video_id === videoId);
        files = files.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return send(res, 200, { files });
      }
      const dlm = p.match(/^\/api\/files\/([^/]+)\/download$/);
      if (dlm && req.method === 'GET') {
        const who = callerIdentity(d, req);
        if (!who) return send(res, 401, { error: 'Sign in required' });
        const f = d.files.find((x) => x.id === dlm[1]);
        if (!f) return send(res, 404, { error: 'File not found' });
        if (who.role === 'client' && f.client_id !== who.clientId) return send(res, 403, { error: 'Not your file' });
        try {
          const downloadUrl = await storage.createDownloadUrl(f.storage_path, 300);
          return send(res, 200, { downloadUrl });
        } catch (e) { return storageDown(e); }
      }
      const delm = p.match(/^\/api\/files\/([^/]+)\/delete$/);
      if (delm && req.method === 'POST') {
        const who = callerIdentity(d, req);
        if (!who) return send(res, 401, { error: 'Sign in required' });
        const idx = d.files.findIndex((x) => x.id === delm[1]);
        if (idx < 0) return send(res, 404, { error: 'File not found' });
        const f = d.files[idx];
        if (who.role === 'client' && f.client_id !== who.clientId) return send(res, 403, { error: 'Not your file' });
        let warning = null;
        try { await storage.deleteObject(f.storage_path); }
        catch (e) {
          if (e instanceof storage.StorageNotConfiguredError) warning = 'Storage was not configured; ledger entry removed.';
          else warning = 'Storage delete failed, ledger entry removed: ' + e.message;
        }
        d.files.splice(idx, 1);
        audit(d, f.client_id, 'file_deleted', `File deleted: ${f.filename}`);
        await putDb(d);
        return send(res, 200, { ok: true, warning });
      }
      if (p === '/api/storage/usage' && req.method === 'GET') {
        if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
        const bytesUsed = d.files.reduce((s, f) => s + (Number(f.bytes) || 0), 0);
        const expiring = d.files.filter((f) => f.expires_at && new Date(f.expires_at).getTime() <= Date.now() + 7 * 24 * 3600 * 1000).length;
        return send(res, 200, { bytesUsed, bytesTotal: STORAGE_TOTAL_BYTES, fileCount: d.files.length, expiringSoon: expiring, storageConfigured: storage.isConfigured() });
      }
      if (p === '/api/admin/purge' && req.method === 'POST') {
        if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
        if (!storage.isConfigured()) return send(res, 503, { error: 'File storage is not configured (set SUPABASE_URL and SUPABASE_SERVICE_KEY)' });
        const now = Date.now();
        const expired = d.files.filter((f) => f.expires_at && new Date(f.expires_at).getTime() <= now);
        let deleted = 0, bytesFreed = 0;
        const errors = [];
        for (const f of expired) {
          try { await storage.deleteObject(f.storage_path); }
          catch (e) { errors.push(`${f.filename}: ${e.message}`); continue; }
          deleted += 1; bytesFreed += Number(f.bytes) || 0;
          d.files = d.files.filter((x) => x.id !== f.id);
          audit(d, f.client_id, 'file_purged', `Expired file purged: ${f.filename}`);
        }
        await putDb(d);
        return send(res, 200, { deleted, bytesFreed, errors });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // Coordinator video actions (stage / schedule / block / unblock / reply)
    // — writes go through updateDb (revision-checked, retried on
    // conflict) so two coordinators acting at once cannot silently lose
    // each other's change. SLA pause arithmetic lives in lib/sla.js.
    if (p.startsWith('/api/videos/')) {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      // ---------- Publish queue (Wave 2D) ----------
      // POST /api/videos/:id/publish — create per-platform publish
      // records and attempt the ones due now. Fails closed PER
      // PLATFORM: with zero adapters enabled every platform refuses
      // honestly, the refusal + plain-language reason land on the
      // record, and postLinks stays untouched. A record already
      // 'sent' is never re-published from here (use retry after a
      // failure, or a new video for a re-post).
      const pubRoute = p.match(/^\/api\/videos\/([^/]+)\/publish(?:\/([^/]+)\/(retry|approve))?$/);
      if (pubRoute && req.method === 'POST') {
        const video = d.videos.find((v) => v.id === pubRoute[1]);
        if (!video) return send(res, 404, { error: 'Video not found' });
        const b = await body(req);
        video.publish = video.publish || {};
        if (pubRoute[2]) {
          const platform = pubRoute[2];
          const action = pubRoute[3];
          if (!publish.PLATFORMS.includes(platform)) return send(res, 400, { error: `Unknown platform: ${platform} — use ${publish.PLATFORMS.join(', ')}` });
          const rec = video.publish[platform];
          if (!rec) return send(res, 404, { error: `No ${platform} publish record for this video — publish it first` });
          if (action === 'approve') {
            if (rec.status !== 'needs_approval') return send(res, 400, { error: `Cannot approve a ${platform} record in status "${rec.status}" — only needs_approval can be approved` });
            rec.status = 'scheduled';
            rec.scheduledFor = rec.scheduledFor || new Date().toISOString();
            rec.updatedAt = new Date().toISOString();
            audit(d, video.clientId, 'publish_approved', `${platform} publish approved for "${video.title}" — scheduled`);
            await putDb(d);
            return send(res, 200, { video, publish: publish.publishSummary(video) });
          }
          // retry: a failed/error record goes back to scheduled with
          // a FRESH idempotency key (a new attempt, not a replay of
          // the failed one) and a reset attempt count.
          if (rec.status !== 'error' && rec.status !== 'failed') return send(res, 400, { error: `Cannot retry a ${platform} record in status "${rec.status}" — only error or failed can be retried` });
          const fresh = publish.newPublishRecord(platform, { scheduledFor: new Date().toISOString() });
          fresh.attempts = 0;
          video.publish[platform] = fresh;
          audit(d, video.clientId, 'publish_retry', `${platform} publish retry queued for "${video.title}" (fresh idempotency key)`);
          await putDb(d);
          return send(res, 200, { video, publish: publish.publishSummary(video) });
        }
        const platforms = Array.isArray(b.platforms) && b.platforms.length ? b.platforms : publish.PLATFORMS;
        const bad = platforms.filter((pl) => !publish.PLATFORMS.includes(pl));
        if (bad.length) return send(res, 400, { error: `Unknown platform(s): ${bad.join(', ')} — use ${publish.PLATFORMS.join(', ')}` });
        const client = d.clients.find((c) => c.id === video.clientId);
        const needsApproval = client && client.approvalMode === 'per_post_approval';
        const scheduledFor = b.scheduledFor || null;
        const created = [];
        for (const pl of platforms) {
          const existing = video.publish[pl];
          if (existing && existing.status === 'sent') { created.push({ platform: pl, status: 'sent', note: 'already published — not re-published' }); continue; }
          const rec = publish.newPublishRecord(pl, { scheduledFor, status: needsApproval ? 'needs_approval' : 'scheduled' });
          video.publish[pl] = rec;
          created.push({ platform: pl, status: rec.status, idempotencyKey: rec.idempotencyKey, scheduledFor: rec.scheduledFor });
        }
        audit(d, video.clientId, 'publish_queued', `Publish queued for "${video.title}" on ${platforms.join(', ')} (${needsApproval ? 'needs approval' : scheduledFor ? `scheduled for ${scheduledFor}` : 'due now'})`);
        let outcomes = [];
        if (!needsApproval && (!scheduledFor || new Date(scheduledFor).getTime() <= Date.now())) {
          // Due now: attempt immediately (zero adapters -> every
          // platform refuses honestly; the worker endpoint does the
          // same for future-due records).
          outcomes = await processDuePublishesForVideo(d, video, Date.now());
        }
        try {
          await putDb(d);
        } catch (e) {
          if (e instanceof VersionConflictError) return send(res, 409, { error: 'Another change landed first — reload and retry the publish' });
          throw e;
        }
        return send(res, 200, { video, created, outcomes: outcomes.map((o) => ({ platform: o.platform, outcome: o.outcome, kind: o.kind })), publish: publish.publishSummary(video) });
      }
      const vm = p.match(/^\/api\/videos\/([^/]+)\/(stage|schedule|block|unblock|reply|replies)$/);
      if (!vm) return send(res, 404, { error: 'Not found' });
      const video = d.videos.find((v) => v.id === vm[1]);
      if (!video) return send(res, 404, { error: 'Video not found' });
      const b = await body(req);
      if (vm[2] === 'stage') {
        const { result: v } = await updateDb((dd) => {
          const vid = dd.videos.find((x) => x.id === vm[1]);
          vid.status = b.status || vid.status;
          // Publishing starts the 30-day file-retention clock for this video's files.
          if (b.status === 'published' && !vid.publishedAt) {
            vid.publishedAt = new Date().toISOString();
            const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
            dd.files.filter((f) => f.video_id === vid.id && !f.expires_at).forEach((f) => { f.expires_at = exp; });
          }
          audit(dd, vid.clientId, 'stage', `Video "${vid.title}" moved to ${vid.status}`);
          return vid;
        });
        return send(res, 200, { video: v });
      }
      if (vm[2] === 'schedule') {
        const { result: v } = await updateDb((dd) => {
          const vid = dd.videos.find((x) => x.id === vm[1]);
          vid.schedule = b.schedule || {};
          audit(dd, vid.clientId, 'scheduled', `Video "${vid.title}" scheduled`);
          return vid;
        });
        return send(res, 200, { video: v });
      }
      if (vm[2] === 'block') {
        // Blocking pauses the 3-day clock: pausedAt starts now. A second
        // block never resets it — the pause keeps running from the first
        // block. blockedReason/blockedOwner keep their old meaning.
        const { result: v } = await updateDb((dd) => {
          const vid = dd.videos.find((x) => x.id === vm[1]);
          const firstBlock = !vid.pausedAt;
          if (firstBlock) vid.pausedAt = new Date().toISOString();
          vid.blockedReason = b.reason || '';
          vid.blockedOwner = b.owner || 'coordinator';
          audit(dd, vid.clientId, 'blocked', `Video "${vid.title}" blocked: ${vid.blockedReason} (clock paused${firstBlock ? '' : ' — already paused, clock kept running from the first block'})`);
          return vid;
        });
        return send(res, 200, { video: v, sla: slaInfo(v) });
      }
      if (vm[2] === 'unblock') {
        // Unblocking resumes the clock: exactly the paused interval is
        // added to the accumulated pause, then pausedAt clears. The
        // active-time deadline moves by exactly the paused time.
        try {
          const { result: v } = await updateDb((dd) => {
            const vid = dd.videos.find((x) => x.id === vm[1]);
            if (!vid.pausedAt) throw Object.assign(new Error('Video is not blocked — nothing to unblock'), { statusCode: 400 });
            const pausedMs = Date.now() - new Date(vid.pausedAt).getTime();
            vid.pausedMsTotal = (Number(vid.pausedMsTotal) || 0) + Math.max(0, pausedMs);
            vid.pausedAt = null;
            const reason = vid.blockedReason;
            vid.blockedReason = '';
            vid.blockedOwner = '';
            audit(dd, vid.clientId, 'unblocked', `Video "${vid.title}" unblocked after ${Math.round(pausedMs / 1000)}s paused${reason ? ` (was: ${reason})` : ''} — clock resumed, deadline moved by the paused time`);
            return vid;
          });
          return send(res, 200, { video: v, sla: slaInfo(v) });
        } catch (e) {
          return send(res, e.statusCode || 500, { error: String(e.message || e) });
        }
      }
      if (vm[2] === 'replies' && req.method === 'GET') {
        return send(res, 200, { replies: d.replies.filter((r) => r.videoId === video.id).slice().sort((a, c) => (a.createdAt < c.createdAt ? 1 : -1)) });
      }
      if (vm[2] === 'reply') {
        // Coordinator-supplied text: log it as-is. It is NOT AI — the old
        // code stamped every reply aiGenerated:true, which was the fake flag.
        // A coordinator-typed reply is already sent by the coordinator,
        // so it lands as status "posted".
        if (b.text) {
          const { result: reply } = await updateDb((dd) => {
            const r = { id: uid(), videoId: video.id, text: b.text, aiGenerated: false, source: 'coordinator', status: 'posted', statusAt: new Date().toISOString(), createdAt: new Date().toISOString() };
            dd.replies.push(r);
            audit(dd, video.clientId, 'reply', 'Coordinator reply logged');
            return r;
          });
          return send(res, 200, { video, reply });
        }
        // AI path: a comment to draft a first-hour reply for.
        if (!b.comment) return send(res, 400, { error: 'Send {text} to log a coordinator reply, or {comment} (+ optional commenter) to draft an AI first-hour reply' });
        const context = buildJobContext(d, { videoId: video.id, clientId: video.clientId });
        const locked = context.lockedNiche;
        const nicheCheck = ai.nichePreCheck({ video, niche: locked });
        const payload = { ...context, niche: locked, comment: b.comment, commenter: b.commenter || '', nicheCheck };
        // Live path: F1 wrapper configured — one synchronous chat turn.
        // The deployed wrapper's chat takes a plain message (agent 'main'
        // until the BCB agent is provisioned); the reply is plain text.
        let fallbackNote = null;
        if (ai.isWrapperConfigured()) {
          try {
            const message = `You are the Beyond Copper Branding first-hour replies agent. Draft ONE reply to a viewer comment on a client video. Reply with ONLY the reply text, at most 280 characters, warm and specific to the comment, in the client's niche voice. Never a generic "Thanks for watching!". Do not invent facts or make promises (discounts, collabs, follow-backs). If the comment is off-niche, hostile, or spam, reply with exactly: DO-NOT-SEND.\n\nVIDEO: ${JSON.stringify(payload.video)}\nLOCKED NICHE: ${JSON.stringify(payload.niche)}\nNICHE PRE-CHECK: ${JSON.stringify(nicheCheck)}\nCOMMENTER: ${b.commenter || 'unknown'}\nCOMMENT: ${b.comment}`;
            const out = await ai.callWrapperChat({ message, userId: 'bcb-coordinator' });
            if (out.reply.trim() === 'DO-NOT-SEND') {
              return send(res, 200, { video, reply: null, flagged: true, note: 'The live model flagged this comment as off-niche, hostile, or spam — no reply drafted.' });
            }
            // Draft-first: the live-drafted reply lands as a DRAFT, not
            // as posted — the coordinator approves it from the desk.
            const { result: reply } = await updateDb((dd) => {
              const r = { id: uid(), videoId: video.id, text: out.reply.trim(), aiGenerated: true, model: 'sophia-wrapper-live', nicheCheck, comment: b.comment, status: 'draft', statusAt: new Date().toISOString(), createdAt: new Date().toISOString() };
              dd.replies.push(r);
              audit(dd, video.clientId, 'reply', 'First-hour AI reply drafted via Sophia wrapper (live) — awaiting coordinator approval');
              return r;
            });
            return send(res, 200, { video, reply });
          } catch (e) {
            // Wrapper failed — fall through to the batch queue rather than
            // faking a reply. The coordinator gets a queued job, not a lie.
            fallbackNote = `Wrapper draft failed (${e.message}) — reply queued as batch job`;
          }
        }
        // Batch path: enqueue; the app-side wrapper poller picks it up
        // (POST /v1/batch) when the wrapper is configured, and the
        // drafted reply lands via the same ingest rules. 202, not a
        // reply — do not present as live.
        const job = { id: uid(), type: 'draft_reply', videoId: video.id, clientId: video.clientId, payload, status: 'queued', result: null, error: null, createdAt: new Date().toISOString(), completedAt: null };
        await updateDb((dd) => {
          if (fallbackNote) audit(dd, video.clientId, 'ai_wrapper_fallback', fallbackNote);
          dd.aiJobs.push(job);
          audit(dd, video.clientId, 'reply_queued', ai.isWrapperConfigured() ? 'First-hour AI reply queued as wrapper batch job' : 'First-hour AI reply queued as batch job (wrapper not configured)');
        });
        kickWrapperJob(job.id);
        return send(res, 202, { video, queued: true, jobId: job.id, nicheCheck, note: ai.isWrapperConfigured() ? 'Batch mode: the reply is queued with the Sophia wrapper (POST /v1/batch). It is NOT live AI — poll GET /api/coordinator/ai/jobs/:id for the drafted reply.' : 'Batch mode: the reply is queued, but the wrapper is not configured on this host — it will run once SOPHIA_WRAPPER_URL, SOPHIA_WRAPPER_TOKEN and SOPHIA_WRAPPER_CA_PEM are set. It is NOT live AI — poll GET /api/coordinator/ai/jobs/:id for the drafted reply.' });
      }
      return send(res, 404, { error: 'Not found' });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Video Publishing App listening on ${PORT} (storage: ${process.env.DATABASE_URL ? 'postgres' : 'json-file'})`));
}
module.exports = { server, pickAccountNumber, containsBanned, threeDigitPool, makeCode, versionBadge, migrateDb, emptyDb, MAX_FILE_BYTES, STORAGE_TOTAL_BYTES, tiktok, tiktokRedirectUri, getValidTiktokToken, ai, VersionConflictError, updateDb, loadFreshDb, putDb, slaInfo, SLA_MS, diffPlan, normalizeWatchItem, diffWatchEditions, feedFreshness, publish, tokens, comments, portableTokens, resolvePublishToken, processDuePublishesForVideo, processMetaEvents };
