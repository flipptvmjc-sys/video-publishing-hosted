# BCB Publish Design — what "publishes by itself" needs (NOT built)

Status 2026-11-17 (Wave 2D): **the app still does not publish to any
real platform — but the publish worker now exists and fails closed.**
`POST /api/videos/:id/publish` creates per-platform records (Buffer
state machine: draft / needs_approval / scheduled / sending / sent /
error / failed) and attempts the due ones; with zero adapters enabled
every platform refuses honestly and the refusal + plain-language
reason land on the record. `postLinks` is written ONLY on platform
confirmation. The TikTok adapter code is complete but NOT enabled
(gated behind `BCB_PUBLISH_TIKTOK_ENABLED=1`, default off). No
platform app or credential has been set up, and no live post has
been made. "Published" stays a manual flag until an adapter is
enabled on Michael's per-platform go-ahead.

## Target flow (after RAM fix + F6 + this build)

```
aiPlans[] (approved plan) → bcb.queue_generation (F6 adapter, gated)
  → finished video file (Supabase Storage, kind=final)
  → coordinator approves per-post (or silence = proceed, Professional Default)
  → bcb.publish → per-platform adapters → post links back into video.postLinks
  → first-hour replies drafted by bcb.draft_reply
```

MCP tool: `bcb.publish` (`lib/ai.js` `MCP_TOOLS`) — input
`{videoId, platforms[]}`. The app-side route does not exist yet; when it
does it will be `POST /api/videos/:id/publish`, coordinator-only, and will
refuse any platform whose adapter + credentials are missing (fail closed,
per platform, with the missing item named in the error).

## Per-platform missing list

### YouTube — NOTHING wired
- Missing: Google Cloud project + YouTube Data API v3 enabled; OAuth 2.0
  client (web) with the app's redirect URI; per-client OAuth tokens stored
  in the token vault (same pattern as TikTok's `lib/tiktok.js` vault);
  upload adapter (`videos.insert`, resumable upload, thumbnail set).
- Missing: quota — **CORRECTED 2026-11-17 (report §7): default is now
  100 `videos.insert` calls/day in its own bucket** (changed June 1,
  2026), 100 `search.list`/day, 10,000 units/day for everything else.
  The old "~6 uploads/day" figure is out of date. Quota belongs to the
  GCP project, not the user — 200 clients share one 100/day pool.
- Missing: app verification if the OAuth consent screen goes beyond test
  users (sensitive scope `youtube.upload`); plus a separate **YouTube
  API compliance audit** with no published timeline — projects created
  after Jul 28, 2020 upload **private-only until the audit passes**.
  Refresh tokens expire after 7 days while the consent screen is in
  Testing. Never promise a client a public YouTube post before the
  audit passes.
- Note: no YouTube credentials exist anywhere in the repo or backups.

### Facebook — NOTHING wired
- Missing: Meta app (Business) with Facebook Login + Pages; Page access
  token for the client's Page; `pages_manage_posts` / `pages_read_engagement`
  permissions; video upload adapter (Graph API resumable upload to
  `/{page-id}/videos`).
- Missing: Meta App Review for those permissions (business verification
  for the owning company may be required).
- Note: Facebook login/posting is separate from the existing TikTok login.

### Instagram — NOTHING wired
- Missing: Instagram Business/Creator account linked to a Facebook Page;
  Meta app with `instagram_basic` + `instagram_business_content_publish`
  (the permission's current name — `instagram_content_publish` is the
  older name for the same capability on the Facebook-login path);
  container-based publish flow (create media container → publish);
  per-client tokens in the vault.
- Missing: Meta App Review for `instagram_business_content_publish`.
- Note: Reels are the publishing surface for BCB's vertical videos; the
  container flow only supports Reels up to 15 minutes.
- **DECIDED Wave 2D (REA question §11.4 — decided from the BCB storage
  code, not from a binary): the signed-URL lifetime fix is a
  LONGER-LIVED signed URL, not the resumable upload path.** The
  mechanism already exists — `lib/storage.js` `createDownloadUrl(path,
  expiresInSeconds)` takes any expiry; only the 300s default is too
  short for Meta's fetch ("We cURL media used in publishing attempts").
  The publish worker signs the final file fresh at attempt time with a
  24-hour expiry, matching the IG container's own 24-hour lifetime.
  The resumable upload path via `rupload.facebook.com` stays the
  fallback if Meta ever rejects signed URLs. No code change was needed
  to the storage module — the fix is the expiry the worker requests.
- **VERIFIED Wave 2D: Instagram API-published posts — Meta's own docs
  disagree (50 vs 100).** The Content Publishing guide's rate-limit
  section says 100 API-published posts within a 24-hour moving period;
  the same guide's carousel section and the `content_publishing_limit`
  reference say 50. Resolution: **plan against 50** and query
  `GET /{ig-user-id}/content_publishing_limit` at runtime, respecting
  the live `quota_total`/`quota_usage` — never hardcode either number.

### TikTok — LOGIN ONLY (wired), posting NOT wired
- Wired today: Login Kit OAuth (`user.info.basic` scope only), token
  vault with refresh, `getValidTiktokToken()` exported for future use.
- **Wave 2D: the Content Posting adapter code is COMPLETE in
  `lib/publish.js` (`tiktokAdapter`: init → poll status until
  `PUBLISH_COMPLETE`, never marking published on init) but NOT
  ENABLED — it refuses before any network call while
  `BCB_PUBLISH_TIKTOK_ENABLED` is unset. Enabling it needs Michael's
  per-platform go-ahead.**
- Missing: **scope widening** — Content Posting API needs
  `video.upload` scope; the TikTok app must be re-approved for it and the
  coordinator must re-connect every client (existing tokens carry only
  `user.info.basic` and cannot post).
- Missing: the TikTok app's keys (`TIKTOK_CLIENT_KEY` /
  `TIKTOK_CLIENT_SECRET`) are NOT in any backup — they exist only as Render
  env vars. If Render loses them, the TikTok app must be recreated in the
  TikTok developer portal and the keys re-entered.
- Missing: Content Posting audit — unaudited apps are restricted to
  `SELF_ONLY`, max 5 posting users/24h; audit takes 2–4 weeks.

## Shared missing pieces

- `TOKEN_VAULT_KEY` (optional today; becomes required once YouTube/FB/IG
  tokens join the vault — the vault derives its key from the coordinator
  password salt when unset, which is acceptable but weaker).
- **Wave 2D — built:** `video.publish` per-platform records with the
  Buffer state machine + idempotency keys + 3×/10-min retry; the token
  vault extended to every platform (`d.platformTokens`, same AES-256-GCM
  record shape as TikTok); token health in three layers (hourly sweep
  `POST /api/worker/tokens/sweep` + pre-slot refresh + pre-call
  validation, `expires_at` stored per token, EXPIRED + FAILED +
  Reconnect on refresh failure, row locked during refresh);
  `BCB_WORKER_TOKEN` for the VPS cron worker endpoints (fails closed
  503 when unset).
- A `video.postLinks` write-back: the schema already has `postLinks: {}`
  on the video record; the publish adapter fills it per platform —
  **only on platform confirmation** (TikTok `PUBLISH_COMPLETE`, IG
  published media ID, YouTube video ID, FB post ID).
- Scheduling: `video.schedule` already holds per-platform date-times; the
  publish path runs on a scheduler — a VPS cron hitting
  `POST /api/worker/publish/run` (Render free tier sleeps, so a VPS-side
  trigger is the honest choice until the host tier changes). The worker
  script lives at `/root/bcb-publish-worker/run-publish-worker.mjs` on
  the VPS; it activates when the code is deployed + `BCB_WORKER_TOKEN`
  is set on Render.
- Comment intake (Wave 2D): `POST /webhooks/meta` (HMAC-SHA256 verify,
  enqueue, 200 fast, dedupe by message id); two-layer replies — Layer 1
  keyword (price/link/info/available → one-sentence public reply routing
  to DM, drafted instantly, still a DRAFT until approved) and Layer 2 AI
  draft (niche + playbook + context, 280-char cap) + human approval;
  reply state machine draft → approved → posted → rejected; first-hour
  timer from `publishedAt`. **VERIFIED Wave 2D: 750 private replies/hour
  per Instagram professional account, one private reply per comment
  within 7 days, 24h follow-up window after the person replies** (Meta
  docs, via multiple independent sources checked Oct–Nov 2026 all
  tracing to developers.facebook.com; the Meta pages themselves are
  JS/login-gated in this environment and were not fetched directly).
  DRAFT-FIRST: nothing auto-posts; silence = proceed does NOT cover
  replies until Michael explicitly decides it.
- Counsel clearance in writing for the "Beyond Copper Branding" name
  before commercial use (still outstanding — blocks commercial launch,
  not the build).

## What NOT to do

- Do not set up any platform app, OAuth client, or credential without
  Michael's explicit go-ahead per platform (each is a developer account
  with review/verification attached).
- Do not widen the TikTok scope in the live app until the Content Posting
  adapter is built — widening scope without the adapter breaks nothing,
  but it forces every client to re-connect for no benefit.
- Do not present a scheduled/manual "published" flag as an automated
  publish. The flag stays manual until `bcb.publish` returns real post
  links.
