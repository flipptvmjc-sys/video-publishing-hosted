// Portable tokens — BCB token portability, step 3 (2026-11-18, code only).
//
// Implements the pattern from
// ~/workspace/research_notes/bcb-research-rea-20261117/report.md §0.5
// ("the exact pattern to implement"): ISSUANCE, not extraction.
//
//   1. Issue per-client scoped tokens, shown once, hash-only stored.
//      One token <-> one client (the Descript API-token shape: one token
//      per tenant/Drive, named, revocable). The issuer keeps no plaintext
//      after the one-time handoff — only a SHA-256 hash.
//   2. Bearer on every call, short-lived access (60 min) + rotating
//      one-time refresh (30 days). Refresh reuse revokes the whole
//      family (RFC 9700 / OAuth 2.1 best practice, §0.4). Refresh
//      happens back-channel only (server-to-server, never through a
//      browser/client).
//   3. Handoffs between our own processes are one-time pops (Descript's
//      `pop-auth-data` shape, §0.3): read -> delete at source -> return
//      once. Never copy a secret into renderer storage, logs, or a
//      second store.
//   4. Storage: hash-only in the app db (d.portableTokens); plaintext
//      lives only in Render env vars at the destination
//      (SOPHIA_WRAPPER_TOKEN / SOPHIA_WRAPPER_REFRESH_TOKEN). Nothing
//      secret in JS-readable storage, source, or telemetry —
//      redactSecrets() strips `*token*` / `*password*` / `Authorization`
//      keys, as Descript's DigestTransform does (§0.3).
//   5. Revocation + audit: immediate, permanent, with lastUsedAt /
//      usageCount per token so a runaway or stolen token is visible and
//      killable per token, not per account. Revoked records are kept
//      for audit with revokedAt set, never reinstated.
//   6. Scopes travel with the key; a key can never grant itself more
//      (§0.1 step 4): `tokens:issue` / `tokens:write` / `*` / `admin`
//      are not issuable scopes — a portable token can never mint
//      another token. Issuance runs only under a coordinator login.
//
// REA questions from §0.5, closed by this build (from the deployed
// wrapper contract, not by guessing):
//   (a) Issuance screen vs CLI — BOTH, same module: the coordinator
//       desk route (POST /api/coordinator/portable-tokens/issue, gated
//       by BCB_PORTABLE_TOKENS_ENABLED=1) and the VPS CLI
//       scripts/issue-portable-token.cjs, which runs ON the VPS and
//       prints the key once for the operator to paste into Render.
//       Tokens come from the Vultr server, NOT Telegram.
//   (b) Long-lived vs short-lived+refresh — short-lived access (60 min,
//       the top of the 15–60 min range in §0.4) + rotating refresh
//       (30 days). NOT the TikTok 24h/365d shape — that is a platform
//       OAuth token; this is a service-to-service bearer.
//   (c) Per-token rate limits — NOT added here. The wrapper already
//       rate-limits 30 req/min per token (FOUNDATION-CONTRACT.md); a
//       per-token limit is a wrapper-side change, listed as a follow-up
//       in docs/token-portability.md.
//
// What this module does NOT do (honest limits — see
// docs/token-portability.md):
//   - It does NOT teach the deployed wrapper (server.py on the VPS) to
//     verify these tokens. Until that wrapper-side change lands, a
//     portable token issued here cannot authenticate a live wrapper
//     call — the live path still uses SOPHIA_WRAPPER_TOKEN as set in
//     Render env vars. This module is the issuance/handoff side;
//     verification on the door is the remaining VPS-side step.
//   - It makes NO network call, reads NO env var at load time, and
//     touches NO live service. All functions are pure except the
//     in-memory one-time pop store (transient by design — a restart
//     loses un-popped handoffs, which is the safe failure: re-issue).
//   - No token value is ever printed, logged, or written to a file by
//     this module. Tests use fixture values only.

const crypto = require('crypto');

const ACCESS_PREFIX = 'bcb_live_';
const REFRESH_PREFIX = 'bcb_refresh_';
const ACCESS_TTL_MS = 60 * 60 * 1000; // 60 minutes — top of the §0.4 15–60 min range
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, one-time use (rotation)
const HANDOFF_TTL_MS = 15 * 60 * 1000; // a one-time pop handoff lives 15 minutes, then it is gone

// Scopes a portable token may carry. These are the BCB wrapper
// capabilities only — never issuance, never admin, never another app.
const ALLOWED_SCOPES = [
  'bcb.chat',
  'bcb.batch',
  'bcb.mcp:plan_video',
  'bcb.mcp:draft_reply',
  'bcb.mcp:niche_check',
  'bcb.mcp:publish',
  'bcb.mcp:queue_generation',
];
// Scopes that can never be issued to a portable token — a key can never
// grant itself more (§0.1 step 4). Any request naming one is refused.
const FORBIDDEN_SCOPES = ['tokens:issue', 'tokens:write', 'tokens:*', 'admin', '*', 'tokens:revoke'];

const SECRET_REDACTED = '<stripped sensitive data>';
const TOKEN_VALUE_RE = /^bcb_(live|refresh)_/;

function hashToken(presented) {
  return crypto.createHash('sha256').update(String(presented), 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// Validate a requested scope list. Returns { ok, scopes } (deduped,
// sorted) or { ok: false, error }.
function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { ok: false, error: 'scopes are required — pick at least one of: ' + ALLOWED_SCOPES.join(', ') };
  }
  const seen = new Set();
  for (const s of scopes) {
    if (typeof s !== 'string' || !s) return { ok: false, error: 'scopes must be non-empty strings' };
    if (FORBIDDEN_SCOPES.includes(s)) {
      return { ok: false, error: `scope "${s}" can never be issued to a portable token — a key cannot mint keys or escalate itself` };
    }
    if (!ALLOWED_SCOPES.includes(s)) return { ok: false, error: `unknown scope "${s}" — allowed: ${ALLOWED_SCOPES.join(', ')}` };
    seen.add(s);
  }
  return { ok: true, scopes: [...seen].sort() };
}

// Mint one per-client scoped token pair. Returns { issued, record }.
// `issued` holds the plaintexts — the ONLY copy, shown once, never
// stored. `record` holds hashes only — that is what is stored.
// `randomBytes` / `nowMs` are injectable so tests are deterministic;
// production callers omit them.
function mintPortableToken({ clientId, name, scopes, nowMs, randomBytes }) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!clientId || typeof clientId !== 'string') throw new Error('clientId is required');
  const checked = validateScopes(scopes);
  if (!checked.ok) throw new Error(checked.error);
  const rand = randomBytes || ((n) => crypto.randomBytes(n));
  const accessToken = ACCESS_PREFIX + rand(24).toString('hex');
  const refreshToken = REFRESH_PREFIX + rand(24).toString('hex');
  const id = 'pt_' + rand(8).toString('hex');
  const createdAt = new Date(now).toISOString();
  const record = {
    id,
    familyId: id,
    name: name || `bcb-${clientId}`,
    app: 'bcb',
    clientId,
    scopes: checked.scopes,
    accessHash: hashToken(accessToken),
    accessPrefix: accessToken.slice(0, 12),
    accessExpiresAt: new Date(now + ACCESS_TTL_MS).toISOString(),
    refreshHash: hashToken(refreshToken),
    refreshPrefix: refreshToken.slice(0, 15),
    refreshExpiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
    refreshUsedAt: null,
    // Hashes of refresh tokens already rotated away. Replaying one
    // is refresh reuse — it revokes the whole family (see
    // rotateRefreshToken). Hashes only, never plaintext.
    usedRefreshHashes: [],
    status: 'active',
    createdAt,
    lastUsedAt: null,
    lastUsedScope: null,
    usageCount: 0,
    revokedAt: null,
    revokedReason: null,
  };
  return {
    issued: { accessToken, refreshToken, accessExpiresAt: record.accessExpiresAt, refreshExpiresAt: record.refreshExpiresAt },
    record,
  };
}

// Public metadata for one record — what a list / desk / audit may show.
// NEVER includes a hash or a plaintext value.
function publicToken(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    app: record.app,
    clientId: record.clientId,
    scopes: [...(record.scopes || [])],
    accessPrefix: record.accessPrefix,
    status: record.status,
    createdAt: record.createdAt,
    accessExpiresAt: record.accessExpiresAt,
    refreshExpiresAt: record.refreshExpiresAt,
    lastUsedAt: record.lastUsedAt,
    lastUsedScope: record.lastUsedScope,
    usageCount: record.usageCount || 0,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
  };
}
function listPortableTokens(records) {
  return (records || []).map(publicToken);
}

// Verify a presented access token for a required scope.
// Returns { ok: true, record } on success (mutates lastUsedAt /
// usageCount on the record — the caller saves), or { ok: false,
// code, error, status } with a DISTINCT machine-readable code (§0.1
// step 7): 401 api_key_revoked / api_key_expired / api_key_unknown /
// api_key_malformed, 403 insufficient_scope.
function verifyAccessToken(records, presented, requiredScope, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (typeof presented !== 'string' || !presented.startsWith(ACCESS_PREFIX) || presented.length < ACCESS_PREFIX.length + 16) {
    return { ok: false, code: 'api_key_malformed', error: 'api_key_malformed', status: 401 };
  }
  const rec = (records || []).find((r) => timingSafeEqualHex(r.accessHash, hashToken(presented)));
  if (!rec) return { ok: false, code: 'api_key_unknown', error: 'api_key_unknown', status: 401 };
  if (rec.status === 'revoked') return { ok: false, code: 'api_key_revoked', error: 'api_key_revoked', status: 401, record: rec };
  if (new Date(rec.accessExpiresAt).getTime() <= now) {
    return { ok: false, code: 'api_key_expired', error: 'api_key_expired', status: 401, record: rec };
  }
  if (requiredScope && !(rec.scopes || []).includes(requiredScope)) {
    return { ok: false, code: 'insufficient_scope', error: 'insufficient_scope', status: 403, record: rec };
  }
  rec.lastUsedAt = new Date(now).toISOString();
  rec.lastUsedScope = requiredScope || null;
  rec.usageCount = (rec.usageCount || 0) + 1;
  return { ok: true, record: rec };
}

// Rotate a refresh token (back-channel only). The presented refresh
// token is one-time use: a valid rotation issues a NEW access +
// refresh pair, marks the old refresh used, and REPLACES the access
// hash — the old access token stops verifying immediately (it was
// short-lived anyway, ≤60 min). Reuse of an already-used refresh
// token revokes the WHOLE family (§0.4): that is how the server tells
// a stolen token from a good one.
// Returns { ok: true, issued, record } or { ok: false, code, error,
// status, familyRevoked }.
function rotateRefreshToken(records, presentedRefresh, nowMs, randomBytes) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (typeof presentedRefresh !== 'string' || !presentedRefresh.startsWith(REFRESH_PREFIX) || presentedRefresh.length < REFRESH_PREFIX.length + 16) {
    return { ok: false, code: 'api_key_malformed', error: 'api_key_malformed', status: 401 };
  }
  const rec = (records || []).find((r) => timingSafeEqualHex(r.refreshHash, hashToken(presentedRefresh)));
  if (rec) {
    if (rec.status === 'revoked') return { ok: false, code: 'api_key_revoked', error: 'api_key_revoked', status: 401, record: rec };
    if (new Date(rec.refreshExpiresAt).getTime() <= now) {
      return { ok: false, code: 'api_key_expired', error: 'api_key_expired', status: 401, record: rec };
    }
  } else {
    // Not the current refresh — is it a USED one being replayed?
    // Refresh reuse is possible theft: revoke the whole family.
    const reused = (records || []).find((r) => (r.usedRefreshHashes || []).some((h) => timingSafeEqualHex(h, hashToken(presentedRefresh))));
    if (reused) {
      if (reused.status !== 'revoked') {
        revokePortableToken(records, reused.id, 'refresh_token_reuse — a used refresh token was presented again; family revoked', now);
      }
      return { ok: false, code: 'api_key_revoked', error: 'api_key_revoked', status: 401, familyRevoked: true, record: reused };
    }
    return { ok: false, code: 'api_key_unknown', error: 'api_key_unknown', status: 401 };
  }
  const rand = randomBytes || ((n) => crypto.randomBytes(n));
  const accessToken = ACCESS_PREFIX + rand(24).toString('hex');
  const refreshToken = REFRESH_PREFIX + rand(24).toString('hex');
  // Retire the old refresh hash into the used list BEFORE replacing
  // it, so a replay of the old token is detectable as reuse.
  rec.usedRefreshHashes = [...(rec.usedRefreshHashes || []), rec.refreshHash];
  rec.refreshUsedAt = new Date(now).toISOString();
  rec.accessHash = hashToken(accessToken);
  rec.accessPrefix = accessToken.slice(0, 12);
  rec.accessExpiresAt = new Date(now + ACCESS_TTL_MS).toISOString();
  rec.refreshHash = hashToken(refreshToken);
  rec.refreshPrefix = refreshToken.slice(0, 15);
  rec.refreshExpiresAt = new Date(now + REFRESH_TTL_MS).toISOString();
  // refreshUsedAt stays as the time the PREVIOUS refresh was rotated
  // (the new refresh token itself is unused until it is presented).
  return {
    ok: true,
    issued: { accessToken, refreshToken, accessExpiresAt: rec.accessExpiresAt, refreshExpiresAt: rec.refreshExpiresAt },
    record: rec,
  };
}

// Revoke a token family immediately and permanently (§0.1 step 6).
// The record is kept for audit with revokedAt set — never reinstated,
// never deleted. Returns the record, or null when the id is unknown.
function revokePortableToken(records, id, reason, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const rec = (records || []).find((r) => r.id === id);
  if (!rec) return null;
  if (rec.status !== 'revoked') {
    rec.status = 'revoked';
    rec.revokedAt = new Date(now).toISOString();
    rec.revokedReason = String(reason || 'revoked by coordinator');
  }
  return rec;
}

// One-time pop handoff (Descript's pop-auth-data shape, §0.3):
// store a value, pop it exactly once, then it is gone at the source.
// A second pop, or a pop after the TTL, returns null. In-memory only
// and per-process — a restart loses un-popped handoffs (safe failure:
// re-issue). The store never logs or serialises a value.
class PopHandoffStore {
  constructor() { this.map = new Map(); }
  create(value, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const id = 'ph_' + crypto.randomBytes(12).toString('hex');
    this.map.set(id, { value, expiresAt: now + HANDOFF_TTL_MS });
    return id;
  }
  pop(id, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const entry = this.map.get(id);
    if (!entry) return null;
    this.map.delete(id); // read once, delete immediately — even on expiry
    if (entry.expiresAt <= now) return null;
    return entry.value;
  }
  size() { return this.map.size; }
}

// Telemetry redaction (Descript DigestTransform shape, §0.3): any key
// ending in Authorization/Password/Token, or containing
// password/token/secret/api-key, is replaced — and any string value
// shaped like a portable token is replaced whole. Returns a deep copy;
// the input is never mutated. Use on anything before it reaches a log,
// an audit line, or an error body.
function redactSecrets(value) {
  if (typeof value === 'string') return TOKEN_VALUE_RE.test(value) ? SECRET_REDACTED : value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|password|secret|authorization|api[-_]?key/i.test(k) ? SECRET_REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}

// Never accept a token in a query string — URLs end up in logs (§0.1
// step 3). True when any query value looks like a portable token or
// any query key is token-shaped.
function tokenInQuery(query) {
  if (!query || typeof query !== 'object') return false;
  for (const [k, v] of Object.entries(query)) {
    if (/token|secret|authorization/i.test(k)) return true;
    if (typeof v === 'string' && TOKEN_VALUE_RE.test(v)) return true;
  }
  return false;
}

// Render env-var block for the operator to paste ONCE into the Render
// dashboard (server-side env vars only — never in git/chat/logs).
// This string itself holds the plaintexts: the caller shows it once
// and never stores or logs it.
function formatRenderEnvVars({ accessToken, refreshToken }) {
  return [
    '# Portable BCB wrapper token — paste into Render env vars ONCE, then close this.',
    '# Shown once: the server stores only hashes and cannot show these again. If lost, revoke and re-issue.',
    `SOPHIA_WRAPPER_TOKEN=${accessToken}`,
    `SOPHIA_WRAPPER_REFRESH_TOKEN=${refreshToken}`,
  ].join('\n');
}

// Feature gate: issuance routes are OFF unless the operator turns them
// on. Read at call time (not load time) so a test child can enable it
// with env alone. Default off = the code ships inert.
function isPortableTokensEnabled(env) {
  const e = env || process.env;
  return String(e.BCB_PORTABLE_TOKENS_ENABLED || '') === '1';
}

module.exports = {
  ACCESS_PREFIX,
  REFRESH_PREFIX,
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  HANDOFF_TTL_MS,
  ALLOWED_SCOPES,
  FORBIDDEN_SCOPES,
  SECRET_REDACTED,
  hashToken,
  validateScopes,
  mintPortableToken,
  publicToken,
  listPortableTokens,
  verifyAccessToken,
  rotateRefreshToken,
  revokePortableToken,
  PopHandoffStore,
  redactSecrets,
  tokenInQuery,
  formatRenderEnvVars,
  isPortableTokensEnabled,
};
