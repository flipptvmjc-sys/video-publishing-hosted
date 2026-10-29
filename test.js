// End-to-end test for the hosted copy. Run: npm test  (starts its own server on 3456)
const { spawn } = require('child_process');
const assert = require('assert');
const { pickAccountNumber, containsBanned, threeDigitPool } = require('./server');

async function main() {
  // Fresh test database every run — the real app also starts empty.
  const fs = require('fs');
  for (const f of ['/tmp/vp-hosted-test-data.json', '/tmp/vp-hosted-test-data-live.json']) { try { fs.unlinkSync(f); } catch {} }
  // Unit: account-number pool
  assert.strictEqual(threeDigitPool().length, 897, 'usable 3-digit pool must be 897');
  assert.ok(!threeDigitPool().some(containsBanned), 'pool must contain no banned sequence');
  for (let i = 0; i < 500; i++) {
    const n = pickAccountNumber([]);
    assert.ok(n >= 100 && n <= 999 && !containsBanned(n), `bad account number ${n}`);
  }
  // Exhaustion -> 4-digit, still banned-free
  const all897 = threeDigitPool();
  const n4 = pickAccountNumber(all897);
  assert.ok(n4 >= 1000 && n4 <= 9999 && !containsBanned(n4), `4-digit fallback bad: ${n4}`);
  console.log('Account-number rules OK: pool 897, banned never issued, 4-digit fallback', n4);

  const port = 3456;
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DATA_FILE: '/tmp/vp-hosted-test-data.json' }, stdio: 'pipe' });
  const base = `http://127.0.0.1:${port}`;
  try {
    // wait for health
    for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
    const api = async (path, method, body, token) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json(); if (!r.ok) throw new Error(`${path} -> ${JSON.stringify(j)}`); return j;
    };
    const s = await api('/api/status', 'GET'); assert.strictEqual(s.coordinatorSetUp, false);
    // Default (no APP_VERSION) must show the Muse marker, never LIVE.
    assert.strictEqual(s.version.env, 'muse');
    assert.strictEqual(s.version.text, '◆ MUSE — TEST / FIXING');
    console.log('Version badge (default) OK:', s.version.text);
    await api('/api/setup', 'POST', { password: 'test-coordinator-pw' });
    const login = await api('/api/login', 'POST', { password: 'test-coordinator-pw' });
    const ct = login.token;
    const c1 = await api('/api/coordinator/clients', 'POST', { name: 'Test Client One', email: 'test1@example.com', phone: '2025550101', approvalMode: 'professional_default' }, ct);
    const c2 = await api('/api/coordinator/clients', 'POST', { name: 'Test Client Two', email: 'test2@example.com', phone: '', approvalMode: 'per_post_approval' }, ct);
    assert.notStrictEqual(c1.client.accountNumber, c2.client.accountNumber, 'account numbers must be unique');
    assert.ok(!containsBanned(c1.client.accountNumber) && !containsBanned(c2.client.accountNumber));
    assert.ok(c1.mailto.startsWith('mailto:test1%40example.com'), 'mailto must be pre-addressed');
    assert.ok(c1.sms && c1.sms.startsWith('sms:'), 'sms link must be present when phone on file');
    assert.strictEqual(c2.sms, null, 'no sms link without a phone');
    console.log('Coordinator created clients:', c1.client.accountNumber, c2.client.accountNumber, 'code:', c1.code.code);

    // Client opens public-style URL, types code -> bridge connected
    const redeem = await api('/api/redeem', 'POST', { code: c1.code.code });
    const list = await api('/api/coordinator/clients?search=Test%20Client%20One', 'GET', null, ct);
    assert.strictEqual(list.clients.length, 1);
    assert.strictEqual(list.clients[0].bridgeConnected, true, 'coordinator must see Bridge connected after redemption');
    assert.ok(list.clients[0].lastOpenedAt, 'lastOpenedAt must be recorded');
    console.log('Bridge connected OK:', list.clients[0].bridgeConnected, list.clients[0].lastOpenedAt);

    const me1 = await api('/api/client/me', 'GET', null, redeem.token);
    assert.strictEqual(me1.client.accountNumber, c1.client.accountNumber);
    await api('/api/client/portfolio', 'POST', { text: 'morning reset videos, home tips', links: 'https://example.com/old', outcome: 'grow a steady series' }, redeem.token);
    const niche = await api(`/api/coordinator/clients/${c1.client.id}/niche`, 'POST', { niche: 'Morning home resets', pillars: ['5-minute reset', 'home tips'], format: 'Short vertical tips', promise: 'One calm, doable reset per video', confidence: 'low' }, ct);
    await api(`/api/client/niches/${niche.niche.id}/decision`, 'POST', { decision: 'agree' }, redeem.token);
    const vid = await api('/api/client/videos', 'POST', { title: '5-minute morning reset', topic: 'Morning reset', promise: 'One calm reset', links: 'https://example.com', thumbnailDirection: 'Let us choose', clipParts: 'use-best-parts', series: 'Morning Reset', episode: '12' }, redeem.token);
    assert.ok(new Date(vid.video.deadlineAt) - new Date(vid.video.intakeCompleteAt) > 2.9 * 24 * 3600 * 1000, '3-day deadline must be ~3 days after intake');
    await api(`/api/videos/${vid.video.id}/schedule`, 'POST', { schedule: { youtube: '2026-11-02 12:00', tiktok: '2026-11-02 17:00', instagram: '2026-11-02 18:00', facebook: '2026-11-02 19:00' } }, ct);
    const me2 = await api('/api/client/me', 'GET', null, redeem.token);
    assert.strictEqual(me2.videos.length, 1, 'client submission must land on the shared record');
    assert.strictEqual(me2.videos[0].schedule.youtube, '2026-11-02 12:00');
    assert.ok(me2.audit.some(a => a.type === 'bridge_connected'), 'proof/audit must contain Bridge connected');
    console.log('Client submission + schedule + proof OK:', me2.videos[0].title);

    // Revoked code must not redeem
    await api(`/api/coordinator/clients/${c1.client.id}/revoke`, 'POST', {}, ct);
    try { await api('/api/redeem', 'POST', { code: c1.code.code }); throw new Error('revoked code should have failed'); }
    catch (e) { assert.ok(/isn't active/.test(e.message), 'revoked code error must say not active'); }
    console.log('Revocation OK.');
    // LIVE mode: same code, APP_VERSION=live, must show green LIVE, never Muse.
    const liveChild = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '3457', DATA_FILE: '/tmp/vp-hosted-test-data-live.json', APP_VERSION: 'live' }, stdio: 'pipe' });
    try {
      let liveStatus = null;
      for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:3457/api/status'); if (r.ok) { liveStatus = await r.json(); break; } } catch {} await new Promise(r => setTimeout(r, 200)); }
      assert.ok(liveStatus, 'LIVE-mode server did not start');
      assert.strictEqual(liveStatus.version.env, 'live');
      assert.strictEqual(liveStatus.version.text, '● LIVE');
      assert.strictEqual(liveStatus.version.colour, '#16a34a');
      console.log('Version badge (APP_VERSION=live) OK:', liveStatus.version.text, liveStatus.version.colour);
    } finally { liveChild.kill(); }
    console.log('ALL TESTS PASSED');
  } finally {
    child.kill();
  }
}
main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
