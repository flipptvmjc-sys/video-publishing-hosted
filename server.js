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

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

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
  return { coordinator: null, clients: [], codes: [], portfolio: [], niches: [], videos: [], audit: [], replies: [], coordinatorTokens: [], clientTokens: [] };
}
function loadDb() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { db = emptyDb(); }
  for (const k of Object.keys(emptyDb())) if (!db[k]) db[k] = emptyDb()[k];
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
  if (r.rows.length) { db = r.rows[0].v; return db; }
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
  return { ...c, codes, activeCode: active || null, bridgeConnected: codes.some((x) => x.opens > 0), lastOpenedAt: codes.reduce((m, x) => (x.lastOpenedAt && (!m || x.lastOpenedAt > m) ? x.lastOpenedAt : m), null) };
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

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (!p.startsWith('/api/')) {
      // Two doors, one backend: '/' is the coordinator-only desk, '/client'
      // is the client-only page. Both share the same record and /api/* routes.
      let file = p === '/' ? '/index.html' : p === '/client' ? '/client.html' : p;
      const fp = path.join(__dirname, 'public', file);
      if (!fp.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(fp);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
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
        const item = { id: uid(), clientId: client.id, text: b.text || '', links: b.links || '', outcome: b.outcome || '', createdAt: new Date().toISOString() };
        d.portfolio.push(item);
        audit(d, client.id, 'portfolio', 'Portfolio package sent by client');
        await putDb();
        return send(res, 200, { item });
      }
      if (p === '/api/client/videos' && req.method === 'POST') {
        const b = await body(req);
        if (!b.title) return send(res, 400, { error: 'Video title is required' });
        const video = { id: uid(), clientId: client.id, title: b.title, topic: b.topic || '', promise: b.promise || '', links: b.links || '', ctas: b.ctas || '', thumbnailDirection: b.thumbnailDirection || '', thumbnailChoice: b.thumbnailChoice || 'let-us-choose', clipParts: b.clipParts || 'use-best-parts', series: b.series || '', episode: b.episode || '', status: 'step1', intakeCompleteAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(), blockedReason: '', blockedOwner: '', schedule: {}, postLinks: {}, createdAt: new Date().toISOString() };
        d.videos.push(video);
        audit(d, client.id, 'video_submitted', `Video submitted: ${video.title} — 3-day clock started`);
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

    // Coordinator video actions (stage / schedule / block / reply) — separate, simple
    if (p.startsWith('/api/videos/')) {
      if (!requireCoordinator(d, req)) return send(res, 401, { error: 'Coordinator login required' });
      const vm = p.match(/^\/api\/videos\/([^/]+)\/(stage|schedule|block|reply)$/);
      if (!vm) return send(res, 404, { error: 'Not found' });
      const video = d.videos.find((v) => v.id === vm[1]);
      if (!video) return send(res, 404, { error: 'Video not found' });
      const b = await body(req);
      if (vm[2] === 'stage') { video.status = b.status || video.status; audit(d, video.clientId, 'stage', `Video "${video.title}" moved to ${video.status}`); }
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
module.exports = { server, pickAccountNumber, containsBanned, threeDigitPool, makeCode, versionBadge };
