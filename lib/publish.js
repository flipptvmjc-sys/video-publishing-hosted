// Publish worker — Wave 2D. Pure functions + the adapter interface, no I/O.
//
// The skeleton (report §2.1, §10 direction 1):
//   capture -> queue/store -> worker picks it up at due time ->
//   decrypt token in memory only -> platform API ->
//   confirmation or failure written back to the SAME record.
//
// Rules this module enforces (never bypassed by callers):
//  - Buffer's state machine per platform: draft / needs_approval /
//    scheduled / sending / sent / error. A failed publish is a
//    first-class state with the platform's own error text on the
//    record — never silent, never per-video-only (3 of 4 live is the
//    dangerous state, surfaced by publishSummary()).
//  - NEVER mark published on init/container creation — only on
//    platform confirmation (TikTok PUBLISH_COMPLETE, IG published
//    media ID, YouTube video ID, FB post ID). An adapter must return
//    { confirmed: true, postId, postUrl }; anything else is not a
//    publish, and the record stays unsent.
//  - Idempotency key per platform attempt, stored on the record.
//  - Per-platform publish with independent retry — Buffer floor:
//    3 attempts at 10-minute intervals, then failed + notice.
//    Auth failures (dead token) are NOT retried as publish attempts:
//    they fail the post with the platform's message and mark the
//    account EXPIRED (see lib/tokens.js) — retrying a dead token
//    only burns rate limits.
//  - Every adapter is gated behind a per-platform enable flag,
//    default OFF. A disabled/missing adapter refuses honestly with
//    the exact missing item named — the worker never pretends.
//    Live posting needs Michael's per-platform go-ahead, one at a
//    time, TikTok first. No platform app, OAuth client, or credential
//    is created by this module.

const crypto = require('crypto');

const PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook'];
const PUBLISH_STATES = ['draft', 'needs_approval', 'scheduled', 'sending', 'sent', 'error', 'failed'];
const MAX_ATTEMPTS = 3; // Buffer floor: 3x
const RETRY_INTERVAL_MS = 10 * 60 * 1000; // Buffer floor: 10-minute intervals

class AdapterNotEnabledError extends Error {
  constructor(platform, reason) {
    super(`${platform} adapter is not enabled: ${reason}`);
    this.name = 'AdapterNotEnabledError';
    this.code = 'adapter_not_enabled';
    this.platform = platform;
  }
}
class AdapterMissingError extends Error {
  constructor(platform, missing) {
    super(`${platform} publish is not wired: ${missing}`);
    this.name = 'AdapterMissingError';
    this.code = 'adapter_missing';
    this.platform = platform;
    this.missing = missing;
  }
}
class PublishNotConfirmedError extends Error {
  constructor(platform, detail) {
    super(`${platform} did not confirm the publish: ${detail}`);
    this.name = 'PublishNotConfirmedError';
    this.code = 'not_confirmed';
    this.platform = platform;
  }
}

function newIdempotencyKey() {
  return crypto.randomBytes(16).toString('hex');
}

// Pure: a fresh per-platform publish record for one video.
function newPublishRecord(platform, { scheduledFor = null, status = 'scheduled' } = {}) {
  const nowIso = new Date().toISOString();
  return {
    platform,
    status, // draft | needs_approval | scheduled | sending | sent | error | failed
    idempotencyKey: newIdempotencyKey(),
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    retryIntervalMs: RETRY_INTERVAL_MS,
    nextRetryAt: null,
    scheduledFor: scheduledFor || null,
    lastError: null, // machine-readable: code + platform message
    errorText: null, // plain-language reason shown to the coordinator
    postId: null, // ONLY set on platform confirmation
    postUrl: null, // ONLY set on platform confirmation
    needsReconnect: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

// Pure: classify a platform error. Auth errors are a reconnect state,
// never a publish retry; rate limits and transient errors are
// retryable; validation errors are not (retrying the same payload
// fails the same way).
function classifyPlatformError(platform, err) {
  const msg = String((err && (err.message || err.error_description || err)) || 'unknown error');
  const code = (err && (err.code || err.error_code || err.status)) || null;
  const text = msg.toLowerCase();
  const authSignals = [
    'invalid_token', 'expired_token', 'invalid token', 'token expired',
    'unauthorized', 'invalid_grant', 'access token', 'refresh token',
    'oauth', 'reauth', 're-auth', 'reconnect', 'permission denied',
  ];
  if (platform === 'facebook' && (code === 190 || code === 102 || code === 463 || /190/.test(msg))) {
    return { kind: 'auth', retryable: false, message: msg };
  }
  if (platform === 'facebook' && (code === 4 || code === 17 || code === 32)) {
    return { kind: 'rate_limit', retryable: true, message: msg };
  }
  if (code === 401 || code === 403 || authSignals.some((s) => text.includes(s))) {
    return { kind: 'auth', retryable: false, message: msg };
  }
  if (code === 429 || /rate limit|too many requests|quota exceeded/i.test(msg)) {
    return { kind: 'rate_limit', retryable: true, message: msg };
  }
  if (/invalid|bad request|validation|unsupported|not allowed|too large|too long/i.test(msg)) {
    return { kind: 'validation', retryable: false, message: msg };
  }
  if (/timeout|timed out|temporarily|try again|service unavailable|5\d\d/i.test(msg)) {
    return { kind: 'transient', retryable: true, message: msg };
  }
  return { kind: 'unknown', retryable: true, message: msg };
}

// Plain-language reason for the desk, from a classified error.
function plainErrorText(platform, classified) {
  const label = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' }[platform] || platform;
  switch (classified.kind) {
    case 'auth':
      return `${label} refused the publish because the account connection is dead or expired (${classified.message}). Reconnect the account — retrying will not help.`;
    case 'rate_limit':
      return `${label} rate-limited the publish (${classified.message}). It will retry automatically.`;
    case 'validation':
      return `${label} rejected the publish (${classified.message}). Fix the video or its details and retry — the same upload will fail the same way.`;
    case 'transient':
      return `${label} had a temporary problem (${classified.message}). It will retry automatically.`;
    default:
      return `${label} publish failed (${classified.message}). It will retry automatically.`;
  }
}

// ---------- Adapters ----------
// Adapter contract: publish({ video, fileUrl, token, attempt, http })
// must resolve { confirmed: true, postId, postUrl } ONLY when the
// platform itself confirmed the post exists, or throw. Returning
// anything without confirmed:true is treated as "not published".
// `http` is injectable ({ postJson, put, get }) so tests can prove
// the confirmation rule without touching a real platform.
//
// Enable flags (env, default OFF — live posting needs Michael's
// per-platform go-ahead, one platform at a time, TikTok first):
//   BCB_PUBLISH_TIKTOK_ENABLED=1, BCB_PUBLISH_YOUTUBE_ENABLED=1,
//   BCB_PUBLISH_INSTAGRAM_ENABLED=1, BCB_PUBLISH_FACEBOOK_ENABLED=1

function adapterEnabled(platform) {
  const flag = {
    tiktok: 'BCB_PUBLISH_TIKTOK_ENABLED',
    youtube: 'BCB_PUBLISH_YOUTUBE_ENABLED',
    instagram: 'BCB_PUBLISH_INSTAGRAM_ENABLED',
    facebook: 'BCB_PUBLISH_FACEBOOK_ENABLED',
  }[platform];
  return process.env[flag] === '1';
}

// Pure: the honest refusal for a platform whose adapter cannot run
// yet — null when the adapter is (potentially) usable. Checked
// BEFORE any token resolution: a disabled/missing adapter makes the
// token state moot, and the record must carry the exact missing item,
// not a misleading "no token" error.
function adapterRefusal(platform) {
  if (platform === 'tiktok') {
    if (!adapterEnabled('tiktok')) {
      return new AdapterNotEnabledError('tiktok', tiktokAdapter.missing);
    }
    return null;
  }
  if (ADAPTER_MISSING[platform]) return new AdapterMissingError(platform, ADAPTER_MISSING[platform]);
  return new AdapterMissingError(platform, `no adapter registered for ${platform}`);
}

// What each not-yet-built adapter needs (report §7). The missing
// string is what the worker stores on the record when it refuses.
const ADAPTER_MISSING = {
  youtube: 'no YouTube adapter yet — needs a Google Cloud project with YouTube Data API v3, an OAuth client, per-client tokens in the vault, and the YouTube compliance audit (uploads stay private-only until it passes). Quota is 100 videos.insert/day per project. No app or credential has been created.',
  instagram: 'no Instagram adapter yet — needs a Meta app with instagram_business_content_publish, a Business/Creator account linked to a Page, per-client tokens in the vault, and App Review. Container flow: public media URL (long-lived signed URL, not the 300s default) -> poll to FINISHED -> media_publish. Plan against 50 API-published posts/24h and query content_publishing_limit at runtime (Meta docs disagree 50 vs 100). No app or credential has been created.',
  facebook: 'no Facebook adapter yet — needs a Meta app with pages_manage_posts, a Page access token in the vault, and App Review + Business Verification. Video via resumable upload (/{page-id}/videos); Reels 3-90s, 30/day. No app or credential has been created.',
};

// TikTok adapter — CODE COMPLETE, NOT ENABLED for live posting.
// Implements the Content Posting API shape from report §7:
//   POST /v2/post/publish/video/init/ (PULL_FROM_URL or chunked upload)
//   -> publish_id + upload_url -> PUT chunks (when not pull-from-URL)
//   -> poll /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE.
// Direct Post needs content_preview_confirmed + express_consent_given,
// a privacy_level, and explicit allow_comment/duet/stitch. Unaudited
// apps are restricted to SELF_ONLY, max 5 posting users/24h.
// The adapter refuses BEFORE any network call while disabled, and it
// refuses while the client token lacks the video.upload scope —
// existing tokens carry only user.info.basic and cannot post, so
// every client must re-connect after the scope widening (which needs
// Michael's go-ahead first; scope widening is NOT done here).
const TIKTOK_API = 'https://open.tiktokapis.com';
const TIKTOK_POSTING_SCOPE = 'video.upload';

const tiktokAdapter = {
  platform: 'tiktok',
  scopeRequired: TIKTOK_POSTING_SCOPE,
  missing: 'TikTok adapter is built but NOT enabled — needs Michael\'s per-platform go-ahead, the video.upload scope widening (existing tokens carry only user.info.basic), every client re-connecting, and the Content Posting audit (unaudited apps: SELF_ONLY, max 5 posting users/24h).',
  async publish({ video, fileUrl, token, attempt, http }) {
    if (!adapterEnabled('tiktok')) {
      throw new AdapterNotEnabledError('tiktok', this.missing);
    }
    if (!token || !token.accessToken) {
      throw new AdapterNotEnabledError('tiktok', 'no TikTok access token for this client — connect TikTok first');
    }
    if (!fileUrl) {
      throw new PublishNotConfirmedError('tiktok', 'no final video file URL to publish from');
    }
    return this.publishViaApi({ video, fileUrl, token, attempt, http });
  },
  // The real API flow, injectable for tests. Never returns confirmed
  // until the status endpoint says PUBLISH_COMPLETE.
  // pollIntervalMs / pollTimeoutMs are overridable so tests can prove
  // the "never confirmed without PUBLISH_COMPLETE" rule quickly.
  async publishViaApi({ video, fileUrl, token, attempt, http, pollIntervalMs = 15000, pollTimeoutMs = 10 * 60 * 1000 }) {
    const h = http || {};
    const postJson = h.postJson || (() => { throw new Error('tiktokAdapter: no http transport injected (live transport not wired — adapter is disabled)'); });
    const getJson = h.getJson || (() => { throw new Error('tiktokAdapter: no http transport injected (live transport not wired — adapter is disabled)'); });
    const auth = { Authorization: `Bearer ${token.accessToken}` };
    const init = await postJson(`${TIKTOK_API}/v2/post/publish/video/init/`, {
      post_info: {
        title: String(video.title || '').slice(0, 220),
        privacy_level: 'SELF_ONLY', // unaudited apps are SELF_ONLY; PUBLIC only after the audit passes
        disable_duet: false,
        disable_stitch: false,
        disable_comment: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: { source: 'PULL_FROM_URL', video_url: fileUrl },
    }, auth);
    // Init is NOT publication. Neither an upload nor an accepted init
    // proves a public post exists — only PUBLISH_COMPLETE does.
    const publishId = init && init.data && init.data.publish_id;
    if (!publishId) {
      throw new PublishNotConfirmedError('tiktok', `init did not return a publish_id (${JSON.stringify(init || {}).slice(0, 200)})`);
    }
    const deadline = Date.now() + pollTimeoutMs;
    for (;;) {
      const st = await getJson(`${TIKTOK_API}/v2/post/publish/status/fetch/`, { publish_id: publishId }, auth);
      const status = st && st.data && st.data.status;
      if (status === 'PUBLISH_COMPLETE') {
        return { confirmed: true, postId: publishId, postUrl: null };
      }
      if (status === 'FAILED') {
        const reason = (st.data && (st.data.fail_reason || st.data.message)) || 'TikTok reported FAILED';
        throw new PublishNotConfirmedError('tiktok', `publish ${publishId} failed: ${reason}`);
      }
      if (Date.now() > deadline) {
        throw new PublishNotConfirmedError('tiktok', `publish ${publishId} did not complete within ${Math.round(pollTimeoutMs / 1000)}s (last status: ${status || 'unknown'}) — the record stays unsent`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  },
};

function stubAdapter(platform) {
  return {
    platform,
    scopeRequired: null,
    missing: ADAPTER_MISSING[platform],
    async publish() {
      throw new AdapterMissingError(platform, ADAPTER_MISSING[platform]);
    },
  };
}

const ADAPTERS = {
  tiktok: tiktokAdapter,
  youtube: stubAdapter('youtube'),
  instagram: stubAdapter('instagram'),
  facebook: stubAdapter('facebook'),
};

// ---------- Worker ----------
// Pure: which publish records are due now (scheduled and due, or
// error with a retry due and attempts left). Never returns a record
// whose token work is someone else's job — the caller resolves tokens.
function duePublishes(videos, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const due = [];
  for (const v of videos || []) {
    const pub = v.publish || {};
    for (const platform of PLATFORMS) {
      const rec = pub[platform];
      if (!rec) continue;
      if (rec.status === 'scheduled' && (!rec.scheduledFor || new Date(rec.scheduledFor).getTime() <= now)) {
        due.push({ video: v, platform, record: rec, kind: 'scheduled' });
      } else if (rec.status === 'error' && rec.nextRetryAt && new Date(rec.nextRetryAt).getTime() <= now && (rec.attempts || 0) < (rec.maxAttempts || MAX_ATTEMPTS)) {
        due.push({ video: v, platform, record: rec, kind: 'retry' });
      }
    }
  }
  return due;
}

// One publish attempt. `getToken` resolves { accessToken, expiresAt }
// (decrypted in memory only, by the caller) or null when the client
// has no token for the platform. Mutates the record + video.postLinks
// in place; the caller saves. Returns an outcome the caller can act
// on (auth failures -> mark the account EXPIRED via lib/tokens.js).
// The record is 'sending' only while the attempt runs; on ANY
// non-confirmation it lands back in 'error' (or 'failed' after the
// last attempt) with the platform's own error text — never 'sent'.
async function runPublishAttempt({ video, platform, record, getToken, getFileUrl, adapters, nowMs }) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const nowIso = new Date(now).toISOString();
  const adapter = (adapters || ADAPTERS)[platform];
  record.status = 'sending';
  record.updatedAt = nowIso;
  const fail = (classified, { auth = false } = {}) => {
    record.attempts = (record.attempts || 0) + 1;
    record.lastError = { kind: classified.kind, message: classified.message, at: nowIso };
    record.errorText = plainErrorText(platform, classified);
    record.needsReconnect = auth;
    if (!classified.retryable || record.attempts >= (record.maxAttempts || MAX_ATTEMPTS)) {
      record.status = 'failed';
      record.nextRetryAt = null;
    } else {
      record.status = 'error';
      record.nextRetryAt = new Date(now + (record.retryIntervalMs || RETRY_INTERVAL_MS)).toISOString();
    }
    record.updatedAt = new Date().toISOString();
    return { outcome: record.status === 'failed' ? 'failed' : 'error', kind: classified.kind, auth, record };
  };
  try {
    if (!adapter) throw new AdapterMissingError(platform, `no adapter registered for ${platform}`);
    // The refusal gate applies to the DEFAULT registry only. A caller
    // that injects its own adapters (tests, or a future live wiring)
    // is authoritative for those adapters — the gate must not veto
    // an injected adapter that can actually run.
    if (!adapters) {
      const refusal = adapterRefusal(platform);
      if (refusal) throw refusal;
    }
    const token = getToken ? await getToken(video.clientId, platform) : null;
    if (!token || !token.accessToken) {
      return fail({ kind: 'auth', retryable: false, message: `no ${platform} access token for this client — the account is not connected` }, { auth: true });
    }
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= now) {
      return fail({ kind: 'auth', retryable: false, message: `${platform} access token expired at ${token.expiresAt} — refresh failed or was not attempted` }, { auth: true });
    }
    // The file URL is resolved AT ATTEMPT TIME (getFileUrl signs a
    // fresh long-lived URL — 24h, matching the IG container lifetime)
    // so a publish never fails on a stale 300s signed URL. A missing
    // final file is an honest refusal, not a silent skip.
    const fileUrl = getFileUrl ? await getFileUrl(video) : (video.finalFileUrl || null);
    const result = await adapter.publish({ video, fileUrl, token, attempt: record, http: null });
    if (!result || result.confirmed !== true || !result.postId) {
      throw new PublishNotConfirmedError(platform, 'adapter returned without a platform confirmation — the post is not published');
    }
    record.status = 'sent';
    record.postId = result.postId;
    record.postUrl = result.postUrl || null;
    record.lastError = null;
    record.errorText = null;
    record.nextRetryAt = null;
    record.updatedAt = new Date().toISOString();
    video.postLinks = video.postLinks || {};
    video.postLinks[platform] = result.postUrl || result.postId;
    return { outcome: 'sent', kind: null, auth: false, record };
  } catch (e) {
    if (e instanceof AdapterNotEnabledError || e instanceof AdapterMissingError) {
      return fail({ kind: 'not_enabled', retryable: false, message: e.message });
    }
    if (e instanceof PublishNotConfirmedError) {
      return fail({ kind: 'not_confirmed', retryable: true, message: e.message });
    }
    const classified = classifyPlatformError(platform, e);
    return fail(classified, { auth: classified.kind === 'auth' });
  }
}

// Pure: the desk-facing summary for one video. `partialFailure` is
// the dangerous state — some platforms live, some failed — surfaced
// explicitly, never hidden behind a per-video flag.
function publishSummary(video) {
  const pub = video.publish || {};
  const per = PLATFORMS.filter((p) => pub[p]).map((p) => ({
    platform: p,
    status: pub[p].status,
    postId: pub[p].postId || null,
    errorText: pub[p].errorText || null,
    needsReconnect: !!pub[p].needsReconnect,
    attempts: pub[p].attempts || 0,
    nextRetryAt: pub[p].nextRetryAt || null,
  }));
  const sent = per.filter((r) => r.status === 'sent').length;
  const failed = per.filter((r) => r.status === 'failed' || r.status === 'error').length;
  return {
    videoId: video.id,
    platforms: per,
    sent,
    failed,
    partialFailure: sent > 0 && failed > 0,
    allSent: per.length > 0 && failed === 0 && sent === per.length,
    hasFailure: failed > 0,
  };
}

module.exports = {
  PLATFORMS,
  PUBLISH_STATES,
  MAX_ATTEMPTS,
  RETRY_INTERVAL_MS,
  AdapterNotEnabledError,
  AdapterMissingError,
  PublishNotConfirmedError,
  newIdempotencyKey,
  newPublishRecord,
  classifyPlatformError,
  plainErrorText,
  adapterEnabled,
  adapterRefusal,
  ADAPTER_MISSING,
  TIKTOK_POSTING_SCOPE,
  tiktokAdapter,
  ADAPTERS,
  duePublishes,
  runPublishAttempt,
  publishSummary,
};
