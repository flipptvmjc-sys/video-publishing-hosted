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
  return { coordinator: null, clients: [], codes: [], portfolio: [], niches: [], videos: [], audit: [], replies: [], coordinatorTokens: [], clientTokens: [], files: [], pendingUploads: [], tiktokOauthStates: [], tiktokTokens: [] };
}
// Idempotent startup migration: backfills any keys missing from an older
// stored db (JSON file or the Postgres kv row) without touching existing data.
function migrateDb(d) {
  const e = emptyDb();
  for (const k of Object.keys(e)) if (d[k] === undefined || d[k] === null) d[k] = e[k];
  return d;
}
function loadDb() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { db = emptyDb(); }
  db = migrateDb(db);
  return db;
}
function saveDb() {
  if (process.env.DATABASE_URL) return; // Postgres path saves per-query below
  fs.writeFileSync(DATA_FILE, JSON.stringify(loadDb(), null, 2));
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
async function pgSave() {
  const pool = await pg();
  await pool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v', ['db', JSON.stringify(db)]);
}
async function getDb() { return process.env.DATABASE_URL ? pgLoad() : loadDb(); }
async function putDb() { return process.env.DATABASE_URL ? pgSave() : saveDb(); }

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
  await putDb();
  return { accessToken: fresh.access_token, openId: fresh.open_id || tok.openId };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
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
        await putDb();
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
        await putDb();
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
          await putDb();
        } catch (e) { return oauthPage(res, 500, 'Could not save the TikTok connection', String(e.message || e).replace(/[<>&]/g, ''), false); }
        return oauthPage(res, 200, 'TikTok connected', `This client's TikTok account is connected. You can close this tab and return to the coordinator desk.`, true);
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (!p.startsWith('/api/')) {
      // Two doors, one backend: '/' is the coordinator-only desk, '/client'
      // is the client-only page. Both share the same record and /api/* routes.
      // '/terms' and '/privacy' serve the public policy pages (required by the
      // networks' developer programs).
      let file = p === '/' ? '/index.html' : p === '/client' ? '/client.html' : p === '/terms' ? '/terms.html' : p === '/privacy' ? '/privacy.html' : p;
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
      await putDb();
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
      await putDb();
      return send(res, 200, { token });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = requireCoordinator(d, req);
      if (t) { d.coordinatorTokens = d.coordinatorTokens.filter((x) => x.token !== t); await putDb(); }
      return send(res, 200, { ok: true });
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
        await putDb();
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
          await putDb();
          return send(res, 200, { client: clientView(d, client), code, message: fullMessage(client, code, baseUrl), mailto: mailtoLink(client, code, baseUrl), sms: client.phone ? smsLink(client, code, baseUrl) : null });
        }
        if (m[2] === 'revoke' && req.method === 'POST') {
          d.codes.filter((x) => x.clientId === client.id).forEach((x) => { x.revoked = true; });
          audit(d, client.id, 'code_revoked', 'All codes revoked by coordinator');
          await putDb();
          return send(res, 200, { client: clientView(d, client) });
        }
        if (m[2] === 'niche' && req.method === 'POST') {
          const b = await body(req);
          const niche = { id: uid(), clientId: client.id, niche: b.niche || '', pillars: b.pillars || [], format: b.format || '', promise: b.promise || '', confidence: b.confidence || 'medium', status: 'proposed', version: (d.niches.filter((x) => x.clientId === client.id).length + 1), createdAt: new Date().toISOString(), clientDecision: null, decisionNote: '' };
          d.niches.push(niche);
          audit(d, client.id, 'niche_proposed', `Niche proposal v${niche.version} created: ${niche.niche}`);
          await putDb();
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
      await putDb();
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
        await putDb();
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
        const video = { id: uid(), clientId: client.id, title: b.title, topic: b.topic || '', promise: b.promise || '', links: b.links || '', ctas: b.ctas || '', thumbnailDirection: b.thumbnailDirection || '', thumbnailChoice: b.thumbnailChoice || 'let-us-choose', clipParts: b.clipParts || 'use-best-parts', series: b.series || '', episode: b.episode || '', status: 'step1', intakeCompleteAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(), blockedReason: '', blockedOwner: '', schedule: {}, postLinks: {}, createdAt: new Date().toISOString() };
        d.videos.push(video);
        for (const fid of fileIds) { const f = d.files.find((x) => x.id === fid); if (f) f.video_id = video.id; }
        audit(d, client.id, 'video_submitted', `Video submitted: ${video.title} — 3-day clock started${fileIds.length ? ` (${fileIds.length} file${fileIds.length > 1 ? 's' : ''} attached)` : ''}`);
        await putDb();
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
        await putDb();
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
          await putDb();
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
          await putDb();
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
        await putDb();
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
        await putDb();
        return send(res, 200, { deleted, bytesFreed, errors });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // Coordinator video actions (stage / schedule / block / reply) — separate, simple
    if (p.startsWith('/api/videos/')) {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const vm = p.match(/^\/api\/videos\/([^/]+)\/(stage|schedule|block|reply)$/);
      if (!vm) return send(res, 404, { error: 'Not found' });
      const video = d.videos.find((v) => v.id === vm[1]);
      if (!video) return send(res, 404, { error: 'Video not found' });
      const b = await body(req);
      if (vm[2] === 'stage') {
        video.status = b.status || video.status;
        // Publishing starts the 30-day file-retention clock for this video's files.
        if (b.status === 'published' && !video.publishedAt) {
          video.publishedAt = new Date().toISOString();
          const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
          d.files.filter((f) => f.video_id === video.id && !f.expires_at).forEach((f) => { f.expires_at = exp; });
        }
        audit(d, video.clientId, 'stage', `Video "${video.title}" moved to ${video.status}`);
      }
      if (vm[2] === 'schedule') { video.schedule = b.schedule || {}; audit(d, video.clientId, 'scheduled', `Video "${video.title}" scheduled`); }
      if (vm[2] === 'block') { video.blockedReason = b.reason || ''; video.blockedOwner = b.owner || 'coordinator'; audit(d, video.clientId, 'blocked', `Video "${video.title}" blocked: ${video.blockedReason} (clock paused)`); }
      if (vm[2] === 'reply') { d.replies.push({ id: uid(), videoId: video.id, text: b.text || '', aiGenerated: true, createdAt: new Date().toISOString() }); audit(d, video.clientId, 'reply', 'First-hour AI reply logged'); }
      await putDb();
      return send(res, 200, { video });
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
module.exports = { server, pickAccountNumber, containsBanned, threeDigitPool, makeCode, versionBadge, migrateDb, emptyDb, MAX_FILE_BYTES, STORAGE_TOTAL_BYTES, tiktok, tiktokRedirectUri, getValidTiktokToken };
