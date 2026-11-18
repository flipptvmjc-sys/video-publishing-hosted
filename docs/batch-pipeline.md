# BCB Batch AI Pipeline — how batch jobs run (Wave 1A, 2026-11-17)

Batch AI works TODAY with no RAM fix and no spend. It is NOT live AI: a
batch job produces content on demand from the builder/coordinator, and the
result lands in the app's database for the desk to show. Never present a
batch result as a live agent answering inside the app.

## The loop (one door — the Sophia wrapper)

```
coordinator (or MCP agent)        BCB app (Render / local)           Sophia wrapper (VPS 66.135.7.93:8443)
POST /api/coordinator/ai/jobs  →  app-side poller submits job    →   POST /v1/batch (202, job_id)
{type, videoId|clientId,          (prompt built from                 one job at a time, 300 MiB floor
 payload}                        lib/batch-prompts/<type>           (job is `gated`, never forced,
                                  + enriched job JSON,              if free RAM is under 300 MiB)
                                  measured ≤ 8000 chars)                ↓
                               ←  poll GET /v1/batch/:id  ←       claude -p runs the prompt
                               ←  ingest via the shared rules  ←  result returns as plain text
                                  (validate → DO-NOT-SEND /
                                  empty guards → store)
                               →  aiPlans / aiPlaybooks / aiWatch / replies[]
```

The old direct `claude -p` runner (`bcb-batch/batch-runner.cjs`) is
RETIRED — see `~/workspace/sophia-ai-build/bcb-batch/README.md`. Batch
goes through the wrapper only, so the wrapper's one-at-a-time + 300 MiB
gating applies to everything. The gateway is never stopped by this code.

Job types (also the MCP tool names in `lib/ai.js`):

| type | Input | Lands in | What the model does |
|---|---|---|---|
| `plan_video` | videoId (+ brief from the video record) | `aiPlans[]` | Script (hook, beats, CTA), captions, thumbnail direction, niche verdict |
| `playbook` | clientId | `aiPlaybooks[]` | Per-client publishing playbook from niche + portfolio + network-watch |
| `network_watch` | none (or `{weekOf}`) | `aiWatch[]` | Weekly what-changed research across YouTube/TikTok/Instagram/Facebook, tuned to each client's niche |
| `niche_check` | videoId | job record only | Pass/fail vs locked niche v1, reasons; a miss recommends remake (default first instinct) |
| `draft_reply` | videoId + comment | `replies[]` (`aiGenerated:true`) | First-hour reply draft in the client's niche voice |

## The poller

`runWrapperJob(jobId)` in `server.js` (kicked fire-and-forget by every
enqueue — coordinator route, reply batch path, MCP receiver):

1. Builds the prompt with `ai.buildBatchPrompt(type, job)` — template +
   enriched job JSON, measured against the 8000-char cap. Compaction
   never drops the locked niche, the video, or the brief/comment: it
   trims portfolio items first (keep 2, then drop), then the latest
   plan, then a long brief. Measured 2026-11-17: a fully enriched job
   (30-item portfolio + latest plan) is 20,561 chars uncompacted —
   over the cap by 2.5× — and compacts to 4,773. If it still does not
   fit, the job fails with `prompt_too_long` instead of silently
   truncating what the model needs to stay grounded.
2. Submits with `ai.callWrapperBatch` (one retry after `Retry-After`
   on 429). Records `wrapperJobId`, status `running`.
3. Polls `GET /v1/batch/:id` every 20s (up to 15 min) to a terminal
   state (`done` / `failed` / `gated`). The wrapper returns the result
   as plain text; `ai.extractBatchJson` pulls the ```json fenced object
   out of it.
4. Ingests through `ingestJobResult` — the SAME validation + guards as
   the HTTP ingest endpoint (below). A job that never reaches a
   terminal state, or whose result is not parseable JSON, is marked
   failed with a reason; nothing is stored.

## Ingest rules (shared by the poller and POST /api/ai/jobs/:id/result)

- **Schema validation per job type.** A result missing the fields its
  job type requires (e.g. a plan with no `title`, a niche check with
  no `verdict`) marks the job failed with a `malformed result` reason.
  Nothing malformed is ever stored as a plan/playbook/watch/reply.
- **DO-NOT-SEND (draft_reply).** If the result text is exactly
  `DO-NOT-SEND`, or `send` is false, no reply is stored — the job
  completes with a flagged note instead.
- **Empty replies are never stored.** An empty/whitespace reply is
  flagged the same way, never written to `replies[]`.
- The live reply path (`POST /api/videos/:id/reply`) applies the same
  DO-NOT-SEND check to synchronous wrapper replies.

## TLS — read this before setting env vars

The wrapper's cert is self-signed. The client (`lib/ai.js`) pins its
SHA-256 fingerprint AND requires the CA PEM (`SOPHIA_WRAPPER_CA_PEM`).
Proven live in the Hub verification: WITHOUT the PEM the call fails
`DEPTH_ZERO_SELF_SIGNED_CERT`; WITH it, calls proceed.
`NODE_TLS_REJECT_UNAUTHORIZED` is never set anywhere — the insecure
flag is gone. Transport is `node:https` with a custom agent;
`rejectUnauthorized` stays true.

- On the VPS the PEM is the file `/opt/sophia/foundation/tls/cert.pem`.
- On Render there is no cert file: set `SOPHIA_WRAPPER_CA_PEM` to the
  PEM text itself (copy the cert from the VPS file). The value is a
  public certificate, not a secret.
- Fingerprint (default, pinned in code; override with
  `SOPHIA_WRAPPER_FINGERPRINT`):
  `CF:70:A4:15:3F:A6:5D:38:21:24:23:1D:B7:77:55:53:6F:2D:02:27:E8:05:DF:C8:2C:79:F9:56:68:04:D1:27`

## Credentials needed (exact names — values are set at deploy time, never here)

| Name | Where it lives | Set by | Status 2026-11-17 |
|---|---|---|---|
| `BCB_AI_TOKEN` | Render env on video-publishing-hosted | Us (Render dashboard) | NOT SET — batch ingest fails closed (503) until set. Ingest ONLY; it does not open the MCP receiver. |
| `SOPHIA_SERVICE_TOKEN` | Render env on video-publishing-hosted — MUST equal the wrapper's `service_token` in `/opt/sophia/foundation/config.json` | Us (Render dashboard; value comes from the foundation config) | NOT SET — MCP dispatch fails closed (503) until set. A DIFFERENT value from `BCB_AI_TOKEN`; the two secrets are never the same. |
| `SOPHIA_WRAPPER_URL` + `SOPHIA_WRAPPER_TOKEN` | Render env | Foundation agent (F1) | BUILT + DEPLOYED — sophia-foundation v1.0.0 live at `https://66.135.7.93:8443` (`POST /v1/chat`, `POST /v1/batch`, `POST /mcp`); only the Render env vars are still missing |
| `SOPHIA_WRAPPER_REFRESH_TOKEN` | Render env (set from a one-time pop) | Us (Render dashboard) | Step 3, code only (2026-11-18): reserved name for the portable token's rotating refresh token. NOT consumed yet — the wrapper has no refresh endpoint until its verification-side change lands (docs/token-portability.md). Until then refresh happens by re-issuing, not by rotation. |
| `BCB_PORTABLE_TOKENS_ENABLED` | Render env (`1` to enable) | Us (Render dashboard) | Step 3, code only (2026-11-18): issuance routes are OFF by default and fail closed 503 unless this is `1`. Set it only after the wrapper learns to verify portable tokens. |
| `SOPHIA_WRAPPER_CA_PEM` | Render env (PEM text) | Us (Render dashboard; copy the cert from the VPS) | NOT SET — wrapper calls fail `tls_ca_missing` until set |
| `DATABASE_URL` (Supabase Postgres) | Render env | Already set on Render (live app reports `postgres`) | SET on host; value NOT in any backup — do not lose it |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Render env | Already set on host (uploads work) | SET on host; value NOT in any backup |
| `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` | Render env | Already set on host (login works) | SET on host; value NOT in any backup |

The live database is Postgres on Supabase (project ref
`zjyrtxkologedbdcpaaf`).

## Deploy status — READ BEFORE TESTING LIVE (Wave 1B finding, 2026-11-17)

**The live Render deploy does NOT have the MCP receiver or the
batch-ingest route.** Wave 1B proved it live: `tools/call
bcb.niche_check` dispatched from the wrapper and Render answered 404
`{"error":"Not found"}`; `POST /api/ai/jobs/smoke-test/result` also
404. The live Render deploy predates the 2026-11-17 12:09 UTC
AI-routes round — the MCP receiver + ingest routes exist only in the
workspace `server.js` and were never deployed.

**Do NOT deploy to Render.** Deploy happens only on Michael's explicit
"push it live" say-so — it has not been given. After deploy, re-run
the live `tools/call` probe: expect `app_error` 503 while
`SOPHIA_SERVICE_TOKEN` is unset, then `{status:"queued"}` once it is
set; and expect ingest 503 while `BCB_AI_TOKEN` is unset. Until then,
verify against a LOCAL test server only.

## Known limits (honest, not blockers)

- **Live chat is RAM-gated on the 2 GB VPS.** `/v1/chat` turns reach
  the gateway, which refuses with 502 `gateway_error` ("Host memory is
  too low for another CLI live session"). That is the expected outcome
  until the RAM decision (4 GB $24/mo / 8 GB $48/mo — NOT made,
  Michael's call). The reply endpoint falls back to the batch queue
  rather than faking a reply. Batch is the live proof until then.
- **network_watch via /v1/batch cannot use web tools yet.** The
  wrapper's batch worker runs `claude -p` with NO `--allowedTools`,
  so network-watch jobs cannot use WebSearch/WebFetch — unverifiable
  claims come back in `"unverified"` instead of researched. The retired
  direct runner passed `--allowedTools` for network_watch; the wrapper
  needs the same flag for `task=network_watch`. That is a wrapper-side
  change for the foundation agent — do not touch the wrapper from here.
- **The wrapper discards the app's error body on HTTP errors**
  (Wave 1B note). On app HTTP errors the wrapper returns only the
  status code (`app_error`), not the app's explanatory text — an
  observability gap, not a blocker. Error bodies are still written for
  direct callers and tests.
- **Poller is in-process.** A queued/running job does not survive an
  app restart (no resume-on-boot yet — wave 2). The job record stays
  `queued`/`running` and the coordinator re-enqueues.

## Guardrails (locked, from the goal file)

- Per-post approval stays opt-in; silence = proceed (Professional Default).
- Every video is checked against the client's locked niche v1 before it is
  queued; remake is the default first instinct when a video misses.
- First-hour replies are drafted by the model from video + comment context
  and logged with the actual model output — never a bare `aiGenerated:true`
  on coordinator-supplied text (that flag is now `false` for such replies).
- No paid model APIs, no platform apps, no credentials are set up by this
  pipeline. Generation and publishing are designed, not live (see
  `docs/publish-design.md`).

## Running the tests

```
cd ~/workspace/hosting-move/video-publishing-hosted
node test.js   # full suite: routes, ingest guards, MCP split token,
               # error codes, caps, TLS pinning, prompt measurement,
               # wrapper-batch poller against an HTTPS stub
```
