# Token portability — step 3 (code only, 2026-11-18)

Implements the pattern in
`~/workspace/research_notes/bcb-research-rea-20261117/report.md` §0.5:
**issuance, not extraction**. The token is *created as a portable
credential*, never pulled out of a server session after the fact.

## What was built

| Piece | Where | Status |
|---|---|---|
| Issuance / verify / rotate / revoke / pop / redact (pure, no network) | `lib/portable-tokens.js` | Built, tested |
| Coordinator issuance routes (issue, list, pop, revoke) + back-channel refresh | `server.js` — `/api/coordinator/portable-tokens/*`, `POST /api/tokens/refresh` | Built, tested, **OFF by default** |
| VPS issuance CLI (runs on the VPS, prints once) | `scripts/issue-portable-token.cjs` | Built, **not run anywhere** |
| This doc | `docs/token-portability.md` | This file |

## The pattern, as implemented

1. **Issue per client, scoped, shown once, hash-only stored.**
   One token ↔ one BCB client, named, with scopes from
   `bcb.chat`, `bcb.batch`, `bcb.mcp:plan_video`, `bcb.mcp:draft_reply`,
   `bcb.mcp:niche_check`, `bcb.mcp:publish`, `bcb.mcp:queue_generation`.
   The stored record (`d.portableTokens[]`) holds SHA-256 hashes of
   the access and refresh tokens, a prefix for identification
   (`bcb_live_…`), expiry, scopes, `lastUsedAt` / `usageCount`, and
   revocation state. No plaintext is ever stored.
2. **Bearer on every call, short-lived access + rotating refresh.**
   Access: 60 minutes (top of the §0.4 15–60 min range). Refresh:
   30 days, one-time use. Rotation issues a new access + refresh pair,
   retires the old refresh hash into `usedRefreshHashes`, and replaces
   the access hash — the old access token stops verifying at once.
   **Refresh reuse revokes the whole family** — replaying a used
   refresh token returns `401 api_key_revoked` with
   `familyRevoked: true` and the family is marked revoked. That is how
   the server tells a stolen token from a good one (§0.4).
3. **Handoffs are one-time pops** (Descript's `pop-auth-data` shape,
   §0.3). Issuing returns a `handoffId`, not the values. Popping it
   (`POST /api/coordinator/portable-tokens/handoff/:id/pop`) returns
   the access + refresh tokens and the Render env-var block exactly
   once, then deletes the handoff at the source. A second pop is
   `410`. Handoffs live 15 minutes, in memory only — a restart loses
   un-popped handoffs, which is the safe failure (re-issue).
4. **Storage: Render env vars at the destination, server-side only.**
   `SOPHIA_WRAPPER_TOKEN` (access) and
   `SOPHIA_WRAPPER_REFRESH_TOKEN` (refresh). Never in git, chat, logs,
   or a query string — a token in a query string is refused `400`
   (URLs end up in logs, §0.1 step 3).
5. **Scopes can never escalate.** `tokens:issue`, `tokens:write`,
   `tokens:*`, `admin`, `*` are not issuable — a portable token can
   never mint another token. Issuance runs only under a coordinator
   login, and only when `BCB_PORTABLE_TOKENS_ENABLED=1` is set on the
   host (off by default; the code ships inert).
6. **Failure is machine-readable** (§0.1 step 7): `401
   api_key_malformed` / `api_key_unknown` / `api_key_expired` /
   `api_key_revoked`, `403 insufficient_scope`. A 401 means fix the
   env var; a 403 means fix the grant; never one silent fallback.
7. **Revocation is immediate and permanent**, with the record kept
   for audit (`revokedAt`, `revokedReason`). Revoked tokens are never
   reinstated. Telemetry redaction: `redactSecrets()` strips any
   `*token*` / `*password*` / `*secret*` / `Authorization` key and any
   `bcb_live_` / `bcb_refresh_` value before it reaches a log, an
   audit line, or an error body (Descript's DigestTransform shape).

## REA questions from §0.5 — closed

- **(a) Issuance screen vs CLI — both, same module.** Coordinator
  desk route for day-to-day issuing; the VPS CLI
  (`scripts/issue-portable-token.cjs`, run as root on the VPS) for
  the first token, when no desk session exists. Tokens come from the
  Vultr server, NOT Telegram.
- **(b) Long-lived vs short-lived+refresh — short-lived+refresh**
  (60 min access / 30 day rotating refresh). Not the TikTok 24h/365d
  shape — that is a platform OAuth token; this is a
  service-to-service bearer.
- **(c) Per-token rate limits — not added here.** The wrapper already
  rate-limits 30 req/min per token (FOUNDATION-CONTRACT.md). A
  per-token limit is a wrapper-side change, listed below.

## What is NOT done — the remaining steps (need Michael's go-ahead)

1. **Wrapper-side verification (VPS, foundation agent).** The
   deployed wrapper (`/opt/sophia/foundation/server.py`) does not
   yet verify portable tokens: it must accept the hash store
   (`/opt/sophia/foundation/portable-tokens.json`, written by the
   CLI), verify a presented access token by hash + scope + expiry,
   and add a back-channel refresh endpoint that the BCB
   `POST /api/tokens/refresh` flow can call (or accept BCB's
   rotation as authoritative — the foundation agent decides; do not
   build both). **Until this lands, a token issued here cannot
   authenticate a live wrapper call** — the live path still uses the
   `SOPHIA_WRAPPER_TOKEN` set in Render env vars. Issuing a token
   today changes nothing live.
2. **Render deploy + env vars.** Deploy the current `server.js` to
   Render (Michael's explicit "push it live" — not given), then set
   `BCB_PORTABLE_TOKENS_ENABLED=1`,
   `SOPHIA_WRAPPER_TOKEN` / `SOPHIA_WRAPPER_REFRESH_TOKEN` (from a
   one-time pop), `BCB_AI_TOKEN`, `SOPHIA_SERVICE_TOKEN`,
   `SOPHIA_WRAPPER_URL`, `SOPHIA_WRAPPER_CA_PEM`. The deploy is
   already owed for the MCP receiver + ingest routes (Wave 1B
   finding); this step rides on it, it does not add a second deploy.
3. **Per-platform TikTok go-ahead** (Michael, one at a time, TikTok
   first) — unchanged by this step; nothing here posts to a platform.
4. **Per-token rate limits on the wrapper** (REA question (c)) —
   optional hardening, foundation agent's call.
5. **Desk UI tab for portable tokens** — the list is in the desk
   aggregate (`portableTokens` + counts) but there is no desk UI
   section yet; issuing today is API-only.

## Operator flow (after steps 1–2)

1. Coordinator logs in, issues a token for the client
   (`POST /api/coordinator/portable-tokens`, scopes
   `bcb.chat,bcb.batch,bcb.mcp:plan_video,bcb.mcp:draft_reply,bcb.mcp:niche_check`).
2. Pop the handoff once, paste both values into Render env vars,
   close the window. The values will not be shown again.
3. The app presents `SOPHIA_WRAPPER_TOKEN` as
   `Authorization: Bearer …` on every wrapper call. Before expiry it
   refreshes back-channel (`POST /api/tokens/refresh` with the
   refresh token in the JSON body) and stores the new pair.
4. If a token is ever suspected stolen: revoke it from the list.
   Every call with it then fails `401 api_key_revoked` at once.
   If a used refresh token is replayed, the family revokes itself.

## Test evidence

`node test.js` — full suite, including the new portable-token unit
tests (mint hash-only, verify ok / scope / revoked / expired /
malformed, rotation, reuse-revokes-family, pop-once, redact, query
refusal, forbidden scopes) and the HTTP tests (disabled-by-default
503, issue → pop once → second pop 410, list shows metadata only,
refresh rotates, old refresh replay revokes the family, revoke →
`api_key_revoked`). Test/fixture token values only — no real token
was created, printed, or stored.
