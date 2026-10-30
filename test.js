// End-to-end test for the hosted copy. Run: npm test  (starts its own server on 3456)
const { spawn } = require('child_process');
const assert = require('assert');
// DATA_FILE for THIS process (unit tests below call putDb indirectly): keep
// junk out of the work dir. Child servers get their own DATA_FILE in env.
process.env.DATA_FILE = '/tmp/vp-oauth-unit-data.json';
const { pickAccountNumber, containsBanned, threeDigitPool, migrateDb, emptyDb, MAX_FILE_BYTES, tiktok, getValidTiktokToken } = require('./server');

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
    // ---- File uploads: validation + fail-closed (no SUPABASE_URL/KEY in test env) ----
    assert.strictEqual(MAX_FILE_BYTES, 50 * 1024 * 1024, 'per-file cap must be 50MB');
    const migd = migrateDb({});
    assert.ok(Array.isArray(migd.files) && Array.isArray(migd.pendingUploads), 'migration must backfill files + pendingUploads');
    assert.ok(Array.isArray(emptyDb().files), 'emptyDb must include files');
    const apiErr = async (path, method, body, token) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j };
    };
    let e1 = await apiErr('/api/uploads/sign', 'POST', { kind: 'video', filename: 'a.mp4', mime: 'video/mp4', bytes: 1000 }, null);
    assert.strictEqual(e1.status, 401, 'sign must require auth');
    e1 = await apiErr('/api/uploads/sign', 'POST', { kind: 'nope', filename: 'a.mp4', mime: 'video/mp4', bytes: 1000 }, ct);
    assert.strictEqual(e1.status, 400, 'invalid kind must 400');
    e1 = await apiErr('/api/uploads/sign', 'POST', { kind: 'video', filename: 'big.mp4', mime: 'video/mp4', bytes: 60 * 1024 * 1024 }, ct);
    assert.strictEqual(e1.status, 400, 'oversize must 400 before storage check');
    assert.ok(/50MB/.test(e1.body.error), 'oversize error must mention 50MB, got: ' + e1.body.error);
    e1 = await apiErr('/api/uploads/sign', 'POST', { kind: 'video', filename: 'a.mp4', mime: 'video/mp4', bytes: 1000, clientId: c1.client.id }, ct);
    assert.strictEqual(e1.status, 503, 'sign must fail closed without storage env');
    assert.ok(/not configured/i.test(e1.body.error), '503 must say storage not configured');
    e1 = await apiErr('/api/uploads/complete', 'POST', { fileId: 'nope', path: 'x' }, ct);
    assert.strictEqual(e1.status, 404, 'complete with bogus fileId must 404');
    const redeem2 = await api('/api/redeem', 'POST', { code: c2.code.code });
    e1 = await apiErr('/api/uploads/sign', 'POST', { kind: 'final', filename: 'f.mp4', mime: 'video/mp4', bytes: 1000 }, redeem2.token);
    assert.strictEqual(e1.status, 403, 'client must not upload kind=final');
    const lf = await api('/api/files?clientId=' + c1.client.id, 'GET', null, redeem2.token);
    assert.ok(Array.isArray(lf.files) && lf.files.length === 0, 'client must only ever see own files');
    await api('/api/files', 'GET', null, redeem2.token);
    e1 = await apiErr('/api/files', 'GET', null, null);
    assert.strictEqual(e1.status, 401, 'files list must require auth');
    e1 = await apiErr('/api/files/nope/download', 'GET', null, ct);
    assert.strictEqual(e1.status, 404, 'download of unknown file must 404');
    e1 = await apiErr('/api/files/nope/delete', 'POST', {}, ct);
    assert.strictEqual(e1.status, 404, 'delete of unknown file must 404');
    const usage = await api('/api/storage/usage', 'GET', null, ct);
    assert.strictEqual(usage.bytesUsed, 0, 'usage must start at 0');
    assert.strictEqual(usage.bytesTotal, 1024 * 1024 * 1024, 'usage total must be 1GB');
    assert.strictEqual(usage.storageConfigured, false, 'storage must report unconfigured in test');
    e1 = await apiErr('/api/storage/usage', 'GET', null, null);
    assert.strictEqual(e1.status, 401, 'usage must require coordinator');
    e1 = await apiErr('/api/admin/purge', 'POST', {}, ct);
    assert.strictEqual(e1.status, 503, 'purge must fail closed without storage env');
    e1 = await apiErr('/api/admin/purge', 'POST', {}, null);
    assert.strictEqual(e1.status, 401, 'purge must require coordinator');
    console.log('Upload routes: validation + fail-closed OK');
    // ---- TikTok Login Kit OAuth ----
    // Fail-closed without TIKTOK_CLIENT_KEY/SECRET on the main test server.
    const rawGet = async (path, token) => {
      const r = await fetch(base + path, { method: 'GET', headers: token ? { Authorization: 'Bearer ' + token } : {} });
      return { status: r.status, text: await r.text(), headers: r.headers };
    };
    let t1 = await apiErr('/auth/tiktok/login?clientId=' + c1.client.id, 'GET', null, ct);
    assert.strictEqual(t1.status, 503, 'tiktok login must 503 without env');
    assert.ok(/TIKTOK_CLIENT_KEY/.test(t1.body.error), '503 must name the missing env vars');
    t1 = await rawGet('/auth/tiktok/callback?code=x&state=y', null);
    assert.strictEqual(t1.status, 503, 'tiktok callback must 503 without env');
    assert.ok(/not connected/i.test(t1.text), 'callback 503 page must say not connected');
    const ts0 = await api('/api/tiktok/status?clientId=' + c1.client.id, 'GET', null, ct);
    assert.strictEqual(ts0.configured, false, 'status must report unconfigured without env');
    assert.strictEqual(ts0.connected, false, 'status must report not connected');
    t1 = await apiErr('/api/tiktok/status?clientId=' + c1.client.id, 'GET', null, null);
    assert.strictEqual(t1.status, 401, 'tiktok status must require coordinator');
    const migT = migrateDb({});
    assert.ok(Array.isArray(migT.tiktokOauthStates) && Array.isArray(migT.tiktokTokens), 'migration must backfill tiktokOauthStates + tiktokTokens');
    console.log('TikTok fail-closed (no env) OK');

    // Unit: auth URL shape, mocked token exchange/refresh, vault crypto, scoping.
    // Fake the env for THIS process only (the main test server above already
    // proved the unconfigured fail-closed path; it runs in its own process).
    process.env.TIKTOK_CLIENT_KEY = 'UNITKEY';
    process.env.TIKTOK_CLIENT_SECRET = 'UNITSECRET';
    const au = tiktok.buildAuthUrl({ clientKey: 'FAKEKEY', redirectUri: 'https://example.com/auth/tiktok/callback', state: 's'.repeat(64) });
    const auq = new URL(au);
    assert.strictEqual(auq.origin + auq.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
    assert.strictEqual(auq.searchParams.get('client_key'), 'FAKEKEY');
    assert.strictEqual(auq.searchParams.get('scope'), 'user.info.basic');
    assert.strictEqual(auq.searchParams.get('response_type'), 'code');
    assert.strictEqual(auq.searchParams.get('redirect_uri'), 'https://example.com/auth/tiktok/callback');
    assert.strictEqual(auq.searchParams.get('state'), 's'.repeat(64));
    const fakeTokens = { access_token: 'AT1', refresh_token: 'RT1', open_id: 'OID1', expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic', token_type: 'Bearer' };
    const okPost = async () => fakeTokens;
    const ex = await tiktok.exchangeCode({ code: 'c', redirectUri: 'https://example.com/auth/tiktok/callback', httpPost: okPost });
    assert.strictEqual(ex.access_token, 'AT1', 'mocked exchange must return tokens');
    const errPost = async () => ({ error: 'invalid_grant', error_description: 'Authorization code is invalid.' });
    try { await tiktok.exchangeCode({ code: 'bad', redirectUri: 'https://example.com/x', httpPost: errPost }); throw new Error('exchange should have thrown'); }
    catch (e) { assert.ok(/Authorization code is invalid/.test(e.message), 'exchange must surface TikTok error_description'); }
    try { await tiktok.exchangeCode({ code: 'c', redirectUri: 'https://example.com/x', httpPost: async () => { throw new Error('boom'); } }); throw new Error('exchange should have thrown'); }
    catch (e) { assert.ok(/boom/.test(e.message), 'exchange must propagate transport errors'); }
    const rf = await tiktok.refreshAccessToken({ refreshToken: 'RT1', httpPost: okPost });
    assert.strictEqual(rf.refresh_token, 'RT1', 'mocked refresh must return tokens');
    try { await tiktok.refreshAccessToken({ refreshToken: 'RT1', httpPost: errPost }); throw new Error('refresh should have thrown'); }
    catch (e) { assert.ok(/invalid/.test(e.message), 'refresh must surface TikTok errors'); }
    delete process.env.TOKEN_VAULT_KEY;
    const vd = { coordinator: { salt: 'unit-test-salt' } };
    const vkey = tiktok.deriveVaultKey(vd);
    assert.strictEqual(vkey.length, 32, 'vault key must be 32 bytes');
    const rt = tiktok.decryptJson(vkey, tiktok.encryptJson(vkey, { a: 1, s: 'x' }));
    assert.deepStrictEqual(rt, { a: 1, s: 'x' }, 'vault encrypt/decrypt must round-trip');
    const recA = tiktok.buildVaultRecord({ clientId: 'clientA', network: 'tiktok', tokenJson: fakeTokens, key: vkey });
    const recB = tiktok.buildVaultRecord({ clientId: 'clientB', network: 'tiktok', tokenJson: { ...fakeTokens, access_token: 'AT-B' }, key: vkey });
    const vault = [recA, recB];
    assert.strictEqual(tiktok.findVaultRecord(vault, 'clientA', 'tiktok'), recA, 'client A must get own record');
    assert.strictEqual(tiktok.findVaultRecord(vault, 'clientB', 'tiktok'), recB, 'client B must get own record');
    assert.strictEqual(tiktok.findVaultRecord(vault, 'clientC', 'tiktok'), null, 'unknown client must get null');
    assert.strictEqual(tiktok.findVaultRecord(vault, 'clientA', 'instagram'), null, 'wrong network must get null');
    const readA = tiktok.readVaultRecord(recA, vkey);
    assert.strictEqual(readA.accessToken, 'AT1', 'vault read must decrypt access token');
    assert.ok(!JSON.stringify(recA).includes('AT1'), 'stored record must not contain the plaintext token');
    assert.strictEqual(tiktok.isTokenFresh(new Date(Date.now() + 3600 * 1000).toISOString()), true, 'token with 1h left is fresh');
    assert.strictEqual(tiktok.isTokenFresh(new Date(Date.now() - 1000).toISOString()), false, 'expired token is not fresh');
    assert.strictEqual(tiktok.isTokenFresh(new Date(Date.now() + 60 * 1000).toISOString()), false, 'token with 1m left is not fresh (5m leeway)');
    console.log('TikTok unit (auth URL, mocked exchange/refresh, vault crypto + scoping) OK');

    // getValidTiktokToken: fresh token returned as-is (http must NOT be called);
    // expired token triggers refresh and the stored record is updated.
    const ud = { coordinator: { salt: 'unit-test-salt' }, tiktokTokens: [] };
    const freshRec = tiktok.buildVaultRecord({ clientId: 'uA', network: 'tiktok', tokenJson: { ...fakeTokens, expires_in: 3600 }, key: vkey });
    ud.tiktokTokens.push(freshRec);
    const explodingPost = async () => { throw new Error('must not call http for a fresh token'); };
    const got1 = await getValidTiktokToken(ud, 'uA', explodingPost);
    assert.strictEqual(got1.accessToken, 'AT1', 'fresh token must be returned without refresh');
    const expiredRec = tiktok.buildVaultRecord({ clientId: 'uB', network: 'tiktok', tokenJson: { ...fakeTokens, access_token: 'OLD', refresh_token: 'RT-OLD', expires_in: -10 }, key: vkey });
    ud.tiktokTokens.push(expiredRec);
    const got2 = await getValidTiktokToken(ud, 'uB', async () => ({ ...fakeTokens, access_token: 'NEW', refresh_token: 'RT-NEW' }));
    assert.strictEqual(got2.accessToken, 'NEW', 'expired token must be refreshed');
    const storedB = tiktok.findVaultRecord(ud.tiktokTokens, 'uB', 'tiktok');
    assert.strictEqual(tiktok.readVaultRecord(storedB, vkey).accessToken, 'NEW', 'refreshed token must be stored');
    assert.strictEqual(await getValidTiktokToken(ud, 'nobody', explodingPost), null, 'unconnected client must get null');
    console.log('getValidTiktokToken (fresh/refresh/null) OK');

    // Second server WITH faked TikTok env: login builds a real 302 to TikTok,
    // state validates, single-use holds, exchange failure -> 502 page.
    const port2 = 3458;
    const child2 = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port2), DATA_FILE: '/tmp/vp-oauth-test-data2.json', TIKTOK_CLIENT_KEY: 'FAKEKEY123', TIKTOK_CLIENT_SECRET: 'FAKESECRET' }, stdio: 'pipe' });
    const base2 = `http://127.0.0.1:${port2}`;
    try {
      for (let i = 0; i < 50; i++) { try { const r = await fetch(base2 + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
      const api2 = async (path, method, body, token, raw) => {
        const r = await fetch(base2 + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
        const j = await r.json(); if (!r.ok) throw new Error(`${path} -> ${JSON.stringify(j)}`); return j;
      };
      await api2('/api/setup', 'POST', { password: 'pw22' });
      const login2 = await api2('/api/login', 'POST', { password: 'pw22' });
      const ct2 = login2.token;
      const cc = await api2('/api/coordinator/clients', 'POST', { name: 'TikTok Client', email: 'tt@example.com' }, ct2);
      let l1 = await api2('/auth/tiktok/login?clientId=' + cc.client.id, 'GET', null, null, true);
      assert.strictEqual(l1.status, 401, 'tiktok login must require coordinator auth');
      l1 = await api2('/auth/tiktok/login?clientId=' + cc.client.id, 'GET', null, ct2, true);
      assert.strictEqual(l1.status, 302, 'tiktok login must 302 to TikTok');
      const loc = l1.headers.get('location');
      const lq = new URL(loc);
      assert.strictEqual(lq.origin + lq.pathname, 'https://www.tiktok.com/v2/auth/authorize/', 'must redirect to TikTok authorize, got: ' + loc);
      assert.strictEqual(lq.searchParams.get('client_key'), 'FAKEKEY123');
      assert.strictEqual(lq.searchParams.get('scope'), 'user.info.basic');
      assert.strictEqual(lq.searchParams.get('response_type'), 'code');
      assert.ok(lq.searchParams.get('redirect_uri').endsWith('/auth/tiktok/callback'), 'redirect_uri must be the callback path, got: ' + lq.searchParams.get('redirect_uri'));
      assert.ok(/^[0-9a-f]{64}$/.test(lq.searchParams.get('state')), 'state must be 64 hex chars');
      assert.ok(!loc.includes('FAKESECRET'), 'redirect must never leak the client secret');
      console.log('TikTok login 302 OK:', lq.origin + lq.pathname);
      const ts2 = await api2('/api/tiktok/status?clientId=' + cc.client.id, 'GET', null, ct2);
      assert.strictEqual(ts2.configured, true, 'status must report configured with env');
      assert.strictEqual(ts2.connected, false, 'status must report not connected before callback');
      let cb = await api2('/auth/tiktok/callback?code=x&state=bogus', 'GET', null, null, true);
      assert.strictEqual(cb.status, 400, 'bogus state must 400');
      assert.ok(/invalid or expired/i.test(cb.text), 'bogus state page must say invalid or expired');
      // Valid state + fake code: TikTok is unreachable from here, so the
      // exchange fails and the callback must fail closed with a 502 page.
      const state = lq.searchParams.get('state');
      cb = await api2(`/auth/tiktok/callback?code=fake&state=${state}`, 'GET', null, null, true);
      assert.strictEqual(cb.status, 502, 'failed exchange must 502, got ' + cb.status);
      assert.ok(/token/i.test(cb.text), '502 page must mention the token failure');
      assert.ok(!cb.text.includes('FAKESECRET'), 'error page must never leak the client secret');
      // State is single-use: same state again must 400.
      cb = await api2(`/auth/tiktok/callback?code=fake&state=${state}`, 'GET', null, null, true);
      assert.strictEqual(cb.status, 400, 'reused state must 400');
      console.log('TikTok callback (state validation, single-use, exchange fail-closed) OK');
    } finally { child2.kill(); }
    try { fs.unlinkSync('/tmp/vp-oauth-unit-data.json'); } catch {}
    try { fs.unlinkSync('/tmp/vp-oauth-test-data2.json'); } catch {}
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
