// Token health — Wave 2D. Extends the TikTok AES-256-GCM vault
// pattern (lib/tiktok.js) to every platform; it does NOT invent a
// second store. Vault records live in d.tiktokTokens (TikTok login)
// and d.platformTokens (youtube / instagram / facebook, same record
// shape: { clientId, network, openId, scope, enc, expiresAt,
// refreshExpiresAt, createdAt }). Tokens are decrypted in memory
// only, at publish time, never in the browser, never in logs.
//
// Three layers (report §2.2 / §10 direction 2):
//   1. Hourly background sweep — refresh any token near expiry.
//   2. Pre-slot check — refresh on the spot right before posting.
//   3. Pre-call validation — a lightweight check before the real
//      call, one more refresh attempt, then mark failed.
// This module implements the classification + the sweep + the death
// state. The actual refresh call for a platform lives with that
// platform's adapter (TikTok's exists in lib/tiktok.js; YouTube /
// Instagram / Facebook refresh is part of their adapters, not built
// yet — a record with no refresh path reports `refresh: 'unavailable'`
// instead of pretending).
//
// Lifetimes (verified, report §2.2):
//   TikTok    access 24h, refresh 365d from first issuance; refresh
//             may return a NEW refresh token — use it, and LOCK the
//             token row during refresh (two workers refreshing one
//             account can each rotate it and one loses).
//   Instagram long-lived token 60 days, refreshable any time after
//             24h old — a weekly cron keeps you permanently 53+ days
//             from expiry; a dead (expired) token cannot be refreshed,
//             only re-OAuth.
//   Facebook  Page token minted from a long-lived user token never
//             expires on its own, but dies when the user changes
//             password, removes the app, or loses the Page role
//             (error 190, subcode 492).
//   YouTube   refresh tokens expire after 7 days while the OAuth
//             consent screen is in Testing.
// On refresh failure the account is marked EXPIRED, the post is
// FAILED with the platform's own message, and a Reconnect chip is
// surfaced — never a silent retry that burns rate limits.

const PLATFORM_TOKEN_LIFETIMES = {
  tiktok: { accessSeconds: 86400, refreshSeconds: 31536000, refreshable: true, refreshNote: 'Refresh may return a NEW refresh token — store it; lock the row during refresh.' },
  instagram: { accessSeconds: 60 * 24 * 3600, refreshSeconds: null, refreshable: true, refreshNote: 'Long-lived token, 60 days; refreshable any time after 24h old. A dead token cannot be refreshed — re-OAuth only.' },
  facebook: { accessSeconds: null, refreshSeconds: null, refreshable: false, refreshNote: 'Page token never expires on its own; dies on password change, app removal, or lost Page role (error 190, subcode 492).' },
  youtube: { accessSeconds: 3600, refreshSeconds: 7 * 24 * 3600, refreshable: true, refreshNote: 'Refresh token expires after 7 days while the consent screen is in Testing.' },
};

// How soon before expiry the sweep treats a token as "near expiry"
// (layer 1) and the pre-slot check treats it as "refresh now"
// (layer 2). Five minutes is the TikTok vault's existing leeway.
const SWEEP_REFRESH_WITHIN_MS = 60 * 60 * 1000; // 1 hour
const PRE_SLOT_REFRESH_WITHIN_MS = 60 * 60 * 1000; // 1 hour
const FRESH_LEEWAY_MS = 5 * 60 * 1000; // 5 minutes

// Pure: health of one vault record at a moment.
function tokenHealth(record, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!record) return { status: 'missing', msLeft: null, action: 'connect' };
  if (record.status === 'expired') {
    return { status: 'expired', msLeft: null, action: 'reconnect', reason: record.expiredReason || 'token expired and refresh failed' };
  }
  const expMs = record.expiresAt ? new Date(record.expiresAt).getTime() : NaN;
  if (!record.expiresAt || Number.isNaN(expMs)) {
    // No expiry recorded (Facebook Page token shape): healthy until
    // the platform says otherwise — a failed call is what kills it.
    return { status: 'ok', msLeft: null, action: 'none', note: 'no expiry recorded — healthy until the platform reports an auth error' };
  }
  const msLeft = expMs - now;
  if (msLeft <= 0) return { status: 'expired', msLeft, action: 'reconnect', reason: `access token expired at ${record.expiresAt}` };
  if (msLeft <= FRESH_LEEWAY_MS) return { status: 'expiring_soon', msLeft, action: 'refresh_now', reason: `access token expires in ${Math.round(msLeft / 1000)}s` };
  if (msLeft <= SWEEP_REFRESH_WITHIN_MS) return { status: 'expiring_soon', msLeft, action: 'refresh_soon', reason: `access token expires in ${Math.round(msLeft / 60000)} minutes` };
  return { status: 'ok', msLeft, action: 'none' };
}

// Pure: the hourly sweep (layer 1). Returns which records need a
// refresh attempt now and which are already dead. The caller performs
// the refresh (per-platform refresh fn) and calls markAccountExpired
// on failure — this function never touches a network or a secret.
function sweepTokenRecords(records, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const toRefresh = [];
  const expired = [];
  for (const rec of records || []) {
    if (rec.status === 'expired') { expired.push(rec); continue; }
    const h = tokenHealth(rec, now);
    if (h.status === 'expired') expired.push(rec);
    else if (h.status === 'expiring_soon') toRefresh.push({ record: rec, health: h });
  }
  return { toRefresh, expired };
}

// Refresh row lock (TikTok rotation rule): one refresh per
// client+platform at a time. In-process only — the worker is a
// single process; two processes must not share a token row, and the
// Postgres path is the same single app process on Render.
const refreshLocks = new Set();
function acquireRefreshLock(clientId, platform) {
  const key = `${clientId}:${platform}`;
  if (refreshLocks.has(key)) return false;
  refreshLocks.add(key);
  return true;
}
function releaseRefreshLock(clientId, platform) {
  refreshLocks.delete(`${clientId}:${platform}`);
}
function refreshLockKey(clientId, platform) { return `${clientId}:${platform}`; }

// Death as a visible state: mark the vault record EXPIRED and fail
// every due publish record for that client+platform with the
// platform's own message + a Reconnect flag. Mutates d in place;
// the caller saves. Returns { recordsFailed, videosTouched }.
function markAccountExpired(d, clientId, platform, reason) {
  const nowIso = new Date().toISOString();
  const msg = String(reason || `${platform} token expired and refresh failed`);
  let recordsFailed = 0;
  const videosTouched = [];
  const allRecords = [...(d.tiktokTokens || []), ...(d.platformTokens || [])];
  for (const rec of allRecords) {
    if (rec.clientId === clientId && rec.network === platform) {
      rec.status = 'expired';
      rec.expiredReason = msg;
      rec.expiredAt = nowIso;
    }
  }
  for (const v of d.videos || []) {
    if (v.clientId !== clientId) continue;
    const rec = (v.publish || {})[platform];
    if (!rec) continue;
    if (['scheduled', 'error', 'sending', 'draft', 'needs_approval'].includes(rec.status)) {
      rec.status = 'failed';
      rec.lastError = { kind: 'auth', message: msg, at: nowIso };
      rec.errorText = `${platform === 'tiktok' ? 'TikTok' : platform === 'youtube' ? 'YouTube' : platform === 'instagram' ? 'Instagram' : 'Facebook'} connection expired: ${msg}. Reconnect the account to publish again — retrying will not help.`;
      rec.needsReconnect = true;
      rec.nextRetryAt = null;
      rec.updatedAt = nowIso;
      recordsFailed += 1;
      videosTouched.push(v.id);
    }
  }
  return { recordsFailed, videosTouched };
}

// Plain-language reconnect instruction per platform (the Reconnect chip).
function reconnectInfo(platform) {
  return {
    tiktok: 'Reconnect TikTok from the coordinator desk — the client signs in again and the app stores a fresh token (video.upload scope is needed to post).',
    youtube: 'Reconnect YouTube from the coordinator desk — the client signs in again with the youtube.upload scope. While the consent screen is in Testing, the refresh token lasts 7 days.',
    instagram: 'Reconnect Instagram from the coordinator desk — the Business/Creator account must be re-linked to its Facebook Page, then the app stores a fresh 60-day token.',
    facebook: 'Reconnect Facebook from the coordinator desk — mint a fresh Page token from a long-lived user token for the client Page.',
  }[platform] || `Reconnect ${platform} from the coordinator desk.`;
}

// Classify an auth-shaped platform error for the death path: is this
// "the token is dead" (mark EXPIRED) or something else?
function isAuthDeath(platform, err) {
  const code = (err && (err.code || err.error_code || err.status)) || null;
  const msg = String((err && (err.message || err.error_description || err)) || '');
  if (platform === 'facebook' && (code === 190 || code === 102 || code === 463)) return true;
  if (code === 401 || code === 403) return true;
  return /invalid_token|expired_token|invalid token|token expired|invalid_grant|refresh token/i.test(msg);
}

module.exports = {
  PLATFORM_TOKEN_LIFETIMES,
  SWEEP_REFRESH_WITHIN_MS,
  PRE_SLOT_REFRESH_WITHIN_MS,
  FRESH_LEEWAY_MS,
  tokenHealth,
  sweepTokenRecords,
  acquireRefreshLock,
  releaseRefreshLock,
  refreshLockKey,
  markAccountExpired,
  reconnectInfo,
  isAuthDeath,
};
