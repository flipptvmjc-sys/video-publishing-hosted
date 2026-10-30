// TikTok Login Kit OAuth for the Video Publishing App.
//
// ALL TikTok API calls live in this module behind a small interface.
// server.js never touches TikTok endpoints or the client secret directly —
// it only uses the functions exported here.
//
// Flow: coordinator clicks "Connect TikTok" for a client ->
//   GET /auth/tiktok/login (coordinator auth) redirects the browser to
//   TikTok's authorize page -> TikTok redirects back to
//   GET /auth/tiktok/callback with ?code=&state= -> the server exchanges the
//   code for tokens and stores them encrypted in the existing db (same
//   JSON blob / Postgres kv pattern as everything else).
//
// Fail-closed: when TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set,
// isConfigured() is false and every operation throws
// TiktokNotConfiguredError. Routes translate that to HTTP 503 — the server
// always boots fine, and the secret never leaves the server.
//
// Token lifetimes (TikTok docs): access_token 24h (86,400s), refresh_token
// 365 days. Refresh tokens rotate — when TikTok returns a new one, the
// stored one is replaced.

const crypto = require('crypto');
const https = require('https');

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const LOGIN_SCOPE = 'user.info.basic';
const REFRESH_LEEWAY_MS = 5 * 60 * 1000; // refresh when < 5 minutes of life left

class TiktokNotConfiguredError extends Error {
  constructor() {
    super('TikTok is not connected yet — set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET');
    this.name = 'TiktokNotConfiguredError';
  }
}

function isConfigured() {
  return !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}
function requireConfigured() {
  if (!isConfigured()) throw new TiktokNotConfiguredError();
}

// Pure: builds the TikTok authorization URL the coordinator's browser is
// redirected to. No network, no secrets.
function buildAuthUrl({ clientKey, redirectUri, state, scope }) {
  const q = new URLSearchParams({
    client_key: clientKey,
    scope: scope || LOGIN_SCOPE,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return AUTH_URL + '?' + q.toString();
}

// Low-level form POST; returns parsed JSON. Kept separate so tests can
// inject a mock httpPost instead of hitting TikTok.
function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const bodyStr = new URLSearchParams(params).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`TikTok returned a non-JSON response (HTTP ${res.statusCode})`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('TikTok token request timed out')));
    req.write(bodyStr);
    req.end();
  });
}

// Exchanges an authorization code for tokens. httpPost is injectable for tests.
async function exchangeCode({ code, redirectUri, httpPost }) {
  requireConfigured();
  const post = httpPost || postForm;
  const j = await post(TOKEN_URL, {
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (j.error || !j.access_token) {
    throw new Error('TikTok token exchange failed: ' + (j.error_description || j.error || 'no access_token returned'));
  }
  return j;
}

// Refreshes an access token. httpPost is injectable for tests.
async function refreshAccessToken({ refreshToken, httpPost }) {
  requireConfigured();
  const post = httpPost || postForm;
  const j = await post(TOKEN_URL, {
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (j.error || !j.access_token) {
    throw new Error('TikTok token refresh failed: ' + (j.error_description || j.error || 'no access_token returned'));
  }
  return j;
}

// ---------- Token vault: encrypted at rest, per-client per-network ----------
// The encryption key comes from TOKEN_VAULT_KEY (set on the host) when
// present. Fallback: derived from the coordinator's salt. The fallback only
// protects against casual reads of the data file — it is documented as
// weaker, because the salt lives in the same store. Set TOKEN_VAULT_KEY
// on Render for real protection.
function deriveVaultKey(d) {
  if (process.env.TOKEN_VAULT_KEY) {
    return crypto.scryptSync(String(process.env.TOKEN_VAULT_KEY), 'tiktok-vault-v1', 32);
  }
  const salt = d && d.coordinator && d.coordinator.salt;
  if (!salt) throw new Error('Token vault has no key: set TOKEN_VAULT_KEY or finish coordinator setup first');
  return crypto.scryptSync(String(salt), 'tiktok-vault-fallback', 32);
}

function encryptJson(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decryptJson(key, blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// Pure: finds the vault record for one client + one network. Tokens are
// scoped per client — a record for client A is never returned for client B.
function findVaultRecord(records, clientId, network) {
  return (records || []).find((r) => r.clientId === clientId && r.network === network) || null;
}

// Pure: builds a new vault record from a token response.
function buildVaultRecord({ clientId, network, tokenJson, key }) {
  const enc = encryptJson(key, {
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    open_id: tokenJson.open_id,
  });
  return {
    clientId,
    network,
    openId: tokenJson.open_id || null,
    scope: tokenJson.scope || LOGIN_SCOPE,
    enc,
    expiresAt: new Date(Date.now() + (Number(tokenJson.expires_in) || 86400) * 1000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + (Number(tokenJson.refresh_expires_in) || 31536000) * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

// Pure: decrypts a vault record. Returns { accessToken, refreshToken, openId }.
function readVaultRecord(rec, key) {
  const t = decryptJson(key, rec.enc);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, openId: t.open_id };
}

// Pure: true when the access token still has more than the leeway left.
function isTokenFresh(expiresAt, nowMs) {
  const ms = new Date(expiresAt).getTime() - (nowMs === undefined ? Date.now() : nowMs);
  return ms > REFRESH_LEEWAY_MS;
}

module.exports = {
  AUTH_URL,
  TOKEN_URL,
  LOGIN_SCOPE,
  TiktokNotConfiguredError,
  isConfigured,
  requireConfigured,
  buildAuthUrl,
  postForm,
  exchangeCode,
  refreshAccessToken,
  deriveVaultKey,
  encryptJson,
  decryptJson,
  findVaultRecord,
  buildVaultRecord,
  readVaultRecord,
  isTokenFresh,
};
