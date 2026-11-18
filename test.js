// End-to-end test for the hosted copy. Run: npm test  (starts its own server on 3456)
const { spawn, execSync } = require('child_process');
const assert = require('assert');
// DATA_FILE for THIS process (unit tests below call putDb indirectly): keep
// junk out of the work dir. Child servers get their own DATA_FILE in env.
process.env.DATA_FILE = '/tmp/vp-oauth-unit-data.json';
const { pickAccountNumber, containsBanned, threeDigitPool, migrateDb, emptyDb, MAX_FILE_BYTES, tiktok, getValidTiktokToken, VersionConflictError, updateDb, loadFreshDb, putDb, slaInfo, SLA_MS, diffPlan, normalizeWatchItem, diffWatchEditions, feedFreshness, publish, tokens, comments, portableTokens, processMetaEvents } = require('./server');

async function main() {
  // Fresh test database every run — the real app also starts empty.
  const fs = require('fs');
  for (const f of ['/tmp/vp-hosted-test-data.json', '/tmp/vp-hosted-test-data-live.json', '/tmp/vp-oauth-unit-data.json']) { try { fs.unlinkSync(f); } catch {} }
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

  // ---- Portable tokens, step 3 (lib/portable-tokens.js) — unit tests.
  // Fixture values only: deterministic random bytes, fixed clock.
  {
    const t0 = Date.parse('2026-11-18T12:00:00.000Z');
    let counter = 0;
    const detRand = (n) => Buffer.from(Array.from({ length: n }, () => (counter++ % 251)));
    const minted = portableTokens.mintPortableToken({ clientId: 'cx-pt', name: 'Test token', scopes: ['bcb.chat', 'bcb.batch', 'bcb.mcp:plan_video'], nowMs: t0, randomBytes: detRand });
    assert.ok(minted.issued.accessToken.startsWith('bcb_live_'), 'access token must carry the bcb_live_ prefix');
    assert.ok(minted.issued.refreshToken.startsWith('bcb_refresh_'), 'refresh token must carry the bcb_refresh_ prefix');
    assert.notStrictEqual(minted.issued.accessToken, minted.issued.refreshToken, 'access and refresh must differ');
    // Hash-only storage: the record holds no plaintext anywhere.
    const recJson = JSON.stringify(minted.record);
    assert.ok(!recJson.includes(minted.issued.accessToken) && !recJson.includes(minted.issued.refreshToken), 'stored record must never contain a plaintext token');
    assert.strictEqual(minted.record.accessHash, portableTokens.hashToken(minted.issued.accessToken), 'access hash must be the SHA-256 of the issued access token');
    assert.strictEqual(new Date(minted.record.accessExpiresAt).getTime() - t0, portableTokens.ACCESS_TTL_MS, 'access must live 60 minutes');
    assert.strictEqual(new Date(minted.record.refreshExpiresAt).getTime() - t0, portableTokens.REFRESH_TTL_MS, 'refresh must live 30 days');
    assert.strictEqual(minted.record.status, 'active');
    // Forbidden scopes: a key can never mint keys or escalate itself.
    for (const bad of ['tokens:issue', 'tokens:write', 'admin', '*', 'bcb.chatx']) {
      assert.throws(() => portableTokens.mintPortableToken({ clientId: 'cx-pt', scopes: ['bcb.chat', bad], nowMs: t0, randomBytes: detRand }), /never be issued|unknown scope/, `scope ${bad} must be refused`);
    }
    assert.throws(() => portableTokens.mintPortableToken({ clientId: 'cx-pt', scopes: [], nowMs: t0, randomBytes: detRand }), /scopes are required/);
    // Verify: ok, scope gate, last-used tracking.
    const store = [minted.record];
    let v = portableTokens.verifyAccessToken(store, minted.issued.accessToken, 'bcb.chat', t0 + 1000);
    assert.strictEqual(v.ok, true, 'valid access token must verify');
    assert.strictEqual(minted.record.usageCount, 1, 'a successful verify must count usage');
    assert.ok(minted.record.lastUsedAt, 'a successful verify must stamp lastUsedAt');
    v = portableTokens.verifyAccessToken(store, minted.issued.accessToken, 'bcb.mcp:publish', t0 + 2000);
    assert.strictEqual(v.ok, false); assert.strictEqual(v.status, 403); assert.strictEqual(v.code, 'insufficient_scope', 'a valid token without the scope must be 403 insufficient_scope, not 401');
    // Distinct 401 codes: malformed / unknown / expired.
    assert.strictEqual(portableTokens.verifyAccessToken(store, 'not-a-token', 'bcb.chat', t0).code, 'api_key_malformed');
    assert.strictEqual(portableTokens.verifyAccessToken(store, 'bcb_live_' + '0'.repeat(48), 'bcb.chat', t0).code, 'api_key_unknown');
    assert.strictEqual(portableTokens.verifyAccessToken(store, minted.issued.accessToken, 'bcb.chat', t0 + portableTokens.ACCESS_TTL_MS + 1000).code, 'api_key_expired', 'an access token past 60 minutes must be api_key_expired');
    // Rotation: new pair, old access dead at once, old refresh replay revokes the family.
    const rot = portableTokens.rotateRefreshToken(store, minted.issued.refreshToken, t0 + 3000, detRand);
    assert.strictEqual(rot.ok, true, 'a valid refresh must rotate');
    assert.notStrictEqual(rot.issued.accessToken, minted.issued.accessToken, 'rotation must issue a new access token');
    assert.notStrictEqual(rot.issued.refreshToken, minted.issued.refreshToken, 'rotation must issue a new refresh token');
    assert.strictEqual(portableTokens.verifyAccessToken(store, minted.issued.accessToken, 'bcb.chat', t0 + 4000).code, 'api_key_unknown', 'the old access token must stop verifying the moment rotation lands');
    assert.strictEqual(portableTokens.verifyAccessToken(store, rot.issued.accessToken, 'bcb.batch', t0 + 4000).ok, true, 'the new access token must verify');
    const replay = portableTokens.rotateRefreshToken(store, minted.issued.refreshToken, t0 + 5000, detRand);
    assert.strictEqual(replay.ok, false); assert.strictEqual(replay.familyRevoked, true, 'replaying a used refresh token must revoke the whole family');
    assert.strictEqual(replay.code, 'api_key_revoked');
    assert.strictEqual(minted.record.status, 'revoked', 'family revocation must mark the record revoked');
    assert.strictEqual(portableTokens.verifyAccessToken(store, rot.issued.accessToken, 'bcb.chat', t0 + 6000).code, 'api_key_revoked', 'after family revocation the new access token must also be dead');
    assert.strictEqual(portableTokens.rotateRefreshToken(store, rot.issued.refreshToken, t0 + 7000, detRand).code, 'api_key_revoked', 'after family revocation the new refresh token must also be dead');
    // Revoke: immediate, permanent, kept for audit, never reinstated.
    const m2 = portableTokens.mintPortableToken({ clientId: 'cx-pt2', scopes: ['bcb.batch'], nowMs: t0, randomBytes: detRand });
    const store2 = [m2.record];
    assert.strictEqual(portableTokens.revokePortableToken(store2, 'nope', 'x', t0), null, 'revoking an unknown id must return null');
    const revoked = portableTokens.revokePortableToken(store2, m2.record.id, 'lost laptop', t0 + 1000);
    assert.strictEqual(revoked.status, 'revoked'); assert.ok(revoked.revokedAt); assert.strictEqual(revoked.revokedReason, 'lost laptop');
    assert.strictEqual(portableTokens.verifyAccessToken(store2, m2.issued.accessToken, 'bcb.batch', t0 + 2000).code, 'api_key_revoked');
    assert.strictEqual(portableTokens.rotateRefreshToken(store2, m2.issued.refreshToken, t0 + 2000, detRand).code, 'api_key_revoked');
    // List must show metadata only — no hash, no plaintext.
    const listed = JSON.stringify(portableTokens.listPortableTokens(store2));
    assert.ok(!listed.includes('accessHash') && !listed.includes('refreshHash') && !listed.includes(m2.issued.accessToken) && !listed.includes(m2.issued.refreshToken), 'list output must never contain a hash or a full token value (the identifying prefix is shown by design)');
    assert.strictEqual(portableTokens.listPortableTokens(store2)[0].accessPrefix, m2.record.accessPrefix, 'list must still show the identifying prefix');
    // One-time pop handoff: read once, delete immediately, return once.
    const pops = new portableTokens.PopHandoffStore();
    const hid = pops.create({ accessToken: 'bcb_live_fixture', refreshToken: 'bcb_refresh_fixture' }, t0);
    assert.deepStrictEqual(pops.pop(hid, t0 + 1000), { accessToken: 'bcb_live_fixture', refreshToken: 'bcb_refresh_fixture' }, 'first pop must return the value');
    assert.strictEqual(pops.pop(hid, t0 + 2000), null, 'a second pop must return nothing — the handoff is gone');
    const hid2 = pops.create('v', t0);
    assert.strictEqual(pops.pop(hid2, t0 + portableTokens.HANDOFF_TTL_MS + 1), null, 'a pop after the 15-minute TTL must return nothing');
    // Redaction: secret-shaped keys and token-shaped values are stripped.
    const red = portableTokens.redactSecrets({ token: 'bcb_live_secret', Authorization: 'Bearer x', nested: { password: 'pw', safe: 'keep me' }, list: ['bcb_refresh_secret', 'plain'] });
    assert.strictEqual(red.token, '<stripped sensitive data>'); assert.strictEqual(red.Authorization, '<stripped sensitive data>');
    assert.strictEqual(red.nested.password, '<stripped sensitive data>'); assert.strictEqual(red.nested.safe, 'keep me');
    assert.strictEqual(red.list[0], '<stripped sensitive data>'); assert.strictEqual(red.list[1], 'plain');
    // Query strings never carry a token.
    assert.strictEqual(portableTokens.tokenInQuery({ token: 'bcb_live_x' }), true);
    assert.strictEqual(portableTokens.tokenInQuery({ q: 'bcb_refresh_x' }), true);
    assert.strictEqual(portableTokens.tokenInQuery({ search: 'morning reset' }), false);
    // Render env block names the two env vars and carries both values once.
    const envBlock = portableTokens.formatRenderEnvVars({ accessToken: 'bcb_live_A', refreshToken: 'bcb_refresh_B' });
    assert.ok(envBlock.includes('SOPHIA_WRAPPER_TOKEN=bcb_live_A') && envBlock.includes('SOPHIA_WRAPPER_REFRESH_TOKEN=bcb_refresh_B'));
    // Gate: off unless explicitly enabled.
    assert.strictEqual(portableTokens.isPortableTokensEnabled({}), false, 'issuance must be off by default');
    assert.strictEqual(portableTokens.isPortableTokensEnabled({ BCB_PORTABLE_TOKENS_ENABLED: '1' }), true);
    // migrateDb backfills the new collections on an old db.
    const oldDb = migrateDb({});
    assert.ok(Array.isArray(oldDb.portableTokens) && Array.isArray(oldDb.portableTokenAudit), 'migrateDb must backfill portableTokens + portableTokenAudit');
    console.log('Portable tokens (unit: mint hash-only, scopes, verify codes, rotation, reuse-revokes-family, revoke, pop-once, redact, query refusal) OK');
  }

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
    // ---- BCB AI: batch jobs, replies rewire, ingest (fail-closed) ----
    // Third server WITH BCB_AI_TOKEN so the ingest endpoint is live.
    const { ai } = require('./server');
    assert.ok(Array.isArray(ai.MCP_TOOLS) && ai.MCP_TOOLS.some((t) => t.name === 'bcb.draft_reply'), 'MCP tools must include bcb.draft_reply');
    assert.ok(ai.MCP_TOOLS.some((t) => t.name === 'bcb.publish'), 'MCP tools must include bcb.publish');
    assert.strictEqual(ai.isWrapperConfigured(), false, 'wrapper must report unconfigured without env');
    const nc0 = ai.nichePreCheck({ video: { title: '5-minute morning reset', topic: 'Morning reset' }, niche: null });
    assert.strictEqual(nc0.pass, null, 'no locked niche must give pass:null, not a false fail');
    const nc1 = ai.nichePreCheck({ video: { title: '5-minute morning reset', topic: 'Morning reset' }, niche: { niche: 'Morning home resets', pillars: ['5-minute reset', 'home tips'], promise: 'One calm reset', version: 1 } });
    assert.strictEqual(nc1.pass, true, 'on-niche video must pass the pre-check');
    assert.ok(nc1.matched.includes('morning') || nc1.matched.includes('reset'), 'pre-check must name matched words');
    const nc2 = ai.nichePreCheck({ video: { title: 'Crypto day trading secrets', topic: 'stocks' }, niche: { niche: 'Morning home resets', pillars: ['5-minute reset'], promise: 'One calm reset', version: 1 } });
    assert.strictEqual(nc2.pass, false, 'off-niche video must fail the pre-check');
    console.log('AI lib (MCP tools, wrapper flag, niche pre-check) OK');
    const port3 = 3459;
    const child3 = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port3), DATA_FILE: '/tmp/vp-ai-test-data.json', BCB_AI_TOKEN: 'test-ai-token', SOPHIA_SERVICE_TOKEN: 'test-service-token' }, stdio: 'pipe' });
    const base3 = `http://127.0.0.1:${port3}`;
    try {
      for (let i = 0; i < 50; i++) { try { const r = await fetch(base3 + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
      const api3 = async (path, method, body, token) => {
        const r = await fetch(base3 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`); return j;
      };
      const api3err = async (path, method, body, token) => {
        const r = await fetch(base3 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      await api3('/api/setup', 'POST', { password: 'pw33' });
      const login3 = await api3('/api/login', 'POST', { password: 'pw33' });
      const ct3 = login3.token;
      const st = await api3('/api/coordinator/ai/status', 'GET', null, ct3);
      assert.strictEqual(st.mode, 'batch-only', 'status must report batch-only without a wrapper');
      assert.ok(st.note.includes('deployed, not configured on Render'), 'batch-only note must say the wrapper is deployed, not configured on Render, got: ' + st.note);
      assert.strictEqual(st.ingestConfigured, true, 'status must report ingest configured with BCB_AI_TOKEN');
      // Defect (g): MCP dispatch fails closed 503 on a host with no
      // SOPHIA_SERVICE_TOKEN (the main test server has neither token set).
      const mcpNoSvc = await apiErr('/api/ai/mcp/bcb.plan_video', 'POST', { client_id: 'x', brief: 'x' }, null);
      assert.strictEqual(mcpNoSvc.status, 503, 'MCP dispatch without SOPHIA_SERVICE_TOKEN must 503, got: ' + mcpNoSvc.status);
      const ac = await api3('/api/coordinator/clients', 'POST', { name: 'AI Client', email: 'ai@example.com' }, ct3);
      const red3 = await api3('/api/redeem', 'POST', { code: ac.code.code });
      const an = await api3(`/api/coordinator/clients/${ac.client.id}/niche`, 'POST', { niche: 'Morning home resets', pillars: ['5-minute reset', 'home tips'], format: 'Short vertical tips', promise: 'One calm, doable reset per video', confidence: 'high' }, ct3);
      await api3(`/api/client/niches/${an.niche.id}/decision`, 'POST', { decision: 'agree' }, red3.token);
      const av = await api3('/api/client/videos', 'POST', { title: '5-minute morning reset', topic: 'Morning reset', promise: 'One calm reset', series: 'Morning Reset', episode: '12' }, red3.token);
      // Enqueue a plan job + a playbook job; bad type must 400.
      const pj = await api3('/api/coordinator/ai/jobs', 'POST', { type: 'plan_video', videoId: av.video.id }, ct3);
      assert.strictEqual(pj.job.status, 'queued', 'plan job must start queued');
      const pb = await api3('/api/coordinator/ai/jobs', 'POST', { type: 'playbook', clientId: ac.client.id }, ct3);
      let bad = await api3err('/api/coordinator/ai/jobs', 'POST', { type: 'teleport' }, ct3);
      assert.strictEqual(bad.status, 400, 'unknown AI job type must 400');
      // Reply endpoint: coordinator text is logged as NOT AI (the old fake flag is gone).
      const cr = await api3(`/api/videos/${av.video.id}/reply`, 'POST', { text: 'Thanks — posting tonight!' }, ct3);
      assert.strictEqual(cr.reply.aiGenerated, false, 'coordinator-supplied reply text must NOT be stamped aiGenerated');
      // AI reply path with no wrapper: 202 queued, with the niche pre-check attached.
      const rq = await api3err(`/api/videos/${av.video.id}/reply`, 'POST', { comment: 'This reset routine actually works — doing it every morning now!', commenter: 'homefan22' }, ct3);
      assert.strictEqual(rq.status, 202, 'AI reply without a wrapper must 202-queue, not fake a reply');
      assert.strictEqual(rq.body.queued, true, '202 body must say queued');
      assert.strictEqual(rq.body.nicheCheck.pass, true, 'on-niche video reply must carry a passing niche pre-check');
      const drJobId = rq.body.jobId;
      let rl = await api3(`/api/videos/${av.video.id}/replies`, 'GET', null, ct3);
      assert.strictEqual(rl.replies.length, 1, 'only the coordinator reply is stored before the batch job lands');
      assert.strictEqual(rl.replies[0].aiGenerated, false);
      // Ingest: no token / wrong token must fail; right token lands the plan.
      bad = await api3err(`/api/ai/jobs/${pj.job.id}/result`, 'POST', { status: 'done', result: {} }, null);
      assert.strictEqual(bad.status, 401, 'ingest without token must 401');
      bad = await api3err(`/api/ai/jobs/${pj.job.id}/result`, 'POST', { status: 'done', result: {} }, 'wrong-token');
      assert.strictEqual(bad.status, 401, 'ingest with wrong token must 401');
      bad = await api3err('/api/ai/jobs/nope/result', 'POST', { status: 'done', result: {} }, 'test-ai-token');
      assert.strictEqual(bad.status, 404, 'ingest for unknown job must 404');
      const ing1 = await api3(`/api/ai/jobs/${pj.job.id}/result`, 'POST', { status: 'done', result: { title: '5-minute morning reset', script: { hook: 'h', beats: ['b1'], cta: 'c', estimatedSeconds: 45 }, nicheCheck: { verdict: 'pass', reasons: ['on-niche'] } } }, 'test-ai-token');
      assert.strictEqual(ing1.job.status, 'done', 'plan job must be done after ingest');
      const plans = await api3('/api/coordinator/ai/plans?videoId=' + av.video.id, 'GET', null, ct3);
      assert.strictEqual(plans.plans.length, 1, 'ingested plan must be readable from the app');
      assert.strictEqual(plans.plans[0].title, '5-minute morning reset');
      // Draft-reply ingest lands a real model-stamped reply in replies[].
      const ing2 = await api3(`/api/ai/jobs/${drJobId}/result`, 'POST', { status: 'done', result: { reply: 'So glad it stuck — the 5-minute reset is the whole point. See you tomorrow morning!', model: 'claude-code-batch', nicheCheck: { pass: true, score: 1, matched: ['morning', 'reset'], reason: 'on-niche' } } }, 'test-ai-token');
      assert.strictEqual(ing2.job.status, 'done');
      rl = await api3(`/api/videos/${av.video.id}/replies`, 'GET', null, ct3);
      assert.strictEqual(rl.replies.length, 2, 'batch-drafted reply must land in replies[]');
      const aiReply = rl.replies.find((r) => r.aiGenerated);
      assert.ok(aiReply && aiReply.text.includes('5-minute reset'), 'model-drafted reply must carry the model text and aiGenerated:true');
      assert.strictEqual(aiReply.model, 'claude-code-batch');
      const gj = await api3(`/api/coordinator/ai/jobs/${drJobId}`, 'GET', null, ct3);
      assert.strictEqual(gj.job.status, 'done');
      // Failed job ingest reports honestly.
      const ing3 = await api3(`/api/ai/jobs/${pb.job.id}/result`, 'POST', { status: 'failed', error: 'model step timed out' }, 'test-ai-token');
      assert.strictEqual(ing3.job.status, 'failed');
      assert.strictEqual(ing3.job.error, 'model step timed out');
      // Ingest guards (defects (h), (i) + schema validation): DO-NOT-SEND,
      // empty replies, and malformed results are never stored.
      const dr2 = await api3('/api/coordinator/ai/jobs', 'POST', { type: 'draft_reply', videoId: av.video.id }, ct3);
      const ingDns = await api3(`/api/ai/jobs/${dr2.job.id}/result`, 'POST', { status: 'done', result: { reply: 'DO-NOT-SEND', send: false, flag: 'spam', nicheCheck: { pass: false, score: 0, matched: [], reason: 'spam' } } }, 'test-ai-token');
      assert.strictEqual(ingDns.job.status, 'done', 'DO-NOT-SEND job must still complete');
      assert.strictEqual(ingDns.job.result.flagged, true, 'DO-NOT-SEND result must be flagged');
      rl = await api3(`/api/videos/${av.video.id}/replies`, 'GET', null, ct3);
      assert.strictEqual(rl.replies.length, 2, 'DO-NOT-SEND must not store a reply');
      const dr3 = await api3('/api/coordinator/ai/jobs', 'POST', { type: 'draft_reply', videoId: av.video.id }, ct3);
      const ingEmpty = await api3(`/api/ai/jobs/${dr3.job.id}/result`, 'POST', { status: 'done', result: { reply: '   ', send: true, nicheCheck: { pass: true, score: 1, matched: [], reason: '' } } }, 'test-ai-token');
      assert.strictEqual(ingEmpty.job.result.flagged, true, 'empty reply must be flagged');
      rl = await api3(`/api/videos/${av.video.id}/replies`, 'GET', null, ct3);
      assert.strictEqual(rl.replies.length, 2, 'empty reply must not be stored');
      const pj2 = await api3('/api/coordinator/ai/jobs', 'POST', { type: 'plan_video', videoId: av.video.id }, ct3);
      const ingBad = await api3(`/api/ai/jobs/${pj2.job.id}/result`, 'POST', { status: 'done', result: { script: { hook: 'h', beats: ['b'], cta: 'c' } } }, 'test-ai-token');
      assert.strictEqual(ingBad.job.status, 'failed', 'malformed plan (no title) must fail the job');
      assert.ok(/malformed/.test(ingBad.job.error), 'malformed failure must say so, got: ' + ingBad.job.error);
      const plans2 = await api3('/api/coordinator/ai/plans?videoId=' + av.video.id, 'GET', null, ct3);
      assert.strictEqual(plans2.plans.length, 1, 'malformed plan must not be stored');
      console.log('Ingest guards (DO-NOT-SEND, empty reply, malformed result) OK');
      // MCP dispatch receiver (F2): token-auth, queues batchable tools, gates the rest.
      bad = await api3err('/api/ai/mcp/bcb.plan_video', 'POST', { client_id: ac.client.id, brief: 'x' }, null);
      assert.strictEqual(bad.status, 401, 'MCP dispatch without token must 401');
      bad = await api3err('/api/ai/mcp/bcb.plan_video', 'POST', { client_id: ac.client.id }, 'test-service-token');
      assert.strictEqual(bad.status, 400, 'MCP plan_video without brief must 400');
      // Defect (g): the ingest token must NOT open the MCP receiver.
      bad = await api3err('/api/ai/mcp/bcb.plan_video', 'POST', { client_id: ac.client.id, brief: 'x' }, 'test-ai-token');
      assert.strictEqual(bad.status, 401, 'MCP dispatch with the ingest token (BCB_AI_TOKEN) must 401 — the secrets are split');
      const mcp1 = await api3('/api/ai/mcp/bcb.plan_video', 'POST', { client_id: ac.client.id, brief: 'A calm 5-minute reset', niche: 'Morning home resets' }, 'test-service-token');
      assert.strictEqual(mcp1.status, 'queued', 'MCP plan_video must queue a batch job');
      const mcp2 = await api3('/api/ai/mcp/bcb.draft_reply', 'POST', { video_id: av.video.id, comment_text: 'Love this routine!' }, 'test-service-token');
      assert.strictEqual(mcp2.status, 'queued', 'MCP draft_reply must queue a batch job');
      const mcp3 = await api3('/api/ai/mcp/bcb.publish', 'POST', { video_id: av.video.id, platforms: ['youtube'] }, 'test-service-token');
      assert.strictEqual(mcp3.status, 'queued', 'MCP publish must queue per-platform publish records, not pretend to publish');
      assert.strictEqual(mcp3.platforms.youtube.status, 'scheduled', 'MCP publish record must start scheduled');
      assert.ok(/^[0-9a-f]{32}$/.test(mcp3.platforms.youtube.idempotencyKey), 'MCP publish record must carry an idempotency key');
      assert.ok(/No platform adapter is enabled yet/.test(mcp3.note), 'MCP publish must say plainly that no adapter is enabled yet');
      const mcp4 = await api3('/api/ai/mcp/bcb.queue_generation', 'POST', { client_id: ac.client.id, plan_id: 'p1', cost_approved: true }, 'test-service-token');
      assert.strictEqual(mcp4.status, 'gated', 'MCP queue_generation must answer gated without F6');
      bad = await api3err('/api/ai/mcp/bcb.teleport', 'POST', {}, 'test-service-token');
      assert.strictEqual(bad.status, 404, 'unknown MCP tool must 404');
      // Defect (j): MCP jobs carry the same enrichment as coordinator jobs.
      const mcpJob = await api3(`/api/coordinator/ai/jobs/${mcp1.jobId}`, 'GET', null, ct3);
      assert.ok(mcpJob.job.payload.lockedNiche && mcpJob.job.payload.lockedNiche.niche === 'Morning home resets', 'MCP plan_video job must carry the locked niche');
      assert.ok(Array.isArray(mcpJob.job.payload.portfolio), 'MCP plan_video job must carry the portfolio');
      assert.ok(mcpJob.job.payload.client && mcpJob.job.payload.client.name === 'AI Client', 'MCP plan_video job must carry the client record');
      const mcpJob2 = await api3(`/api/coordinator/ai/jobs/${mcp2.jobId}`, 'GET', null, ct3);
      assert.ok(mcpJob2.job.payload.video && mcpJob2.job.payload.video.title === '5-minute morning reset', 'MCP draft_reply job must carry the video record');
      assert.ok(mcpJob2.job.payload.lockedNiche, 'MCP draft_reply job must carry the locked niche');
      assert.ok(Array.isArray(mcpJob2.job.payload.portfolio), 'MCP draft_reply job must carry the portfolio');
      console.log('MCP dispatch receiver (queue + gate, split token, enriched jobs) OK');
    } finally { child3.kill(); try { fs.unlinkSync('/tmp/vp-ai-test-data.json'); } catch {} }
    // ---- Live wrapper path, against a stub wrapper speaking the REAL contract ----
    // The stub mimics the deployed foundation wrapper exactly: POST /v1/chat
    // {app, agent, message, user_id} -> {reply}; POST /v1/batch -> 202;
    // GET /v1/batch/:id -> done with a fenced-JSON result. It serves HTTPS
    // with a fresh self-signed cert so the client's CA-PEM + fingerprint
    // pinning is exercised for real. This verifies the app's live-path
    // request shape and response handling; the deployed wrapper itself is
    // verified separately on the VPS (see BCB-NOTES.md).
    const https = require('https');
    const stubCert = '/tmp/vp-stub-cert.pem';
    const stubKey = '/tmp/vp-stub-key.pem';
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${stubKey} -out ${stubCert} -days 2 -nodes -subj "/CN=127.0.0.1"`, { stdio: 'pipe' });
    const fpOut = execSync(`openssl x509 -in ${stubCert} -noout -fingerprint -sha256`, { encoding: 'utf8' });
    const stubFp = fpOut.split('=')[1].trim();
    assert.ok(/^[0-9A-F:]{95}$/.test(stubFp), 'stub cert fingerprint must parse, got: ' + fpOut);
    let stubSaw = null;
    let stubBatchSaw = null;
    const stubPlan = { title: '5-minute morning reset', script: { hook: 'h', beats: ['b1'], cta: 'c', estimatedSeconds: 45 }, captions: ['cap1'], thumbnail: { direction: 'calm morning light', overlayText: 'Reset in 5' }, nicheCheck: { verdict: 'pass', reasons: ['on-niche'] } };
    const stub = https.createServer({ key: fs.readFileSync(stubKey), cert: fs.readFileSync(stubCert) }, (req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        const parsedBody = JSON.parse(buf || '{}');
        if (req.url === '/v1/chat' && req.headers.authorization === 'Bearer stub-wrapper-token') {
          stubSaw = { path: req.url, auth: req.headers.authorization, body: parsedBody };
          // Error-mapping triggers (unit tests below drive these).
          if (parsedBody.message === 'TRIGGER-401') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' })); }
          if (parsedBody.message === 'TRIGGER-429') { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '42' }); return res.end(JSON.stringify({ error: 'rate_limited' })); }
          if (parsedBody.message === 'TRIGGER-503') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'ram_gated' })); }
          if (parsedBody.message === 'TRIGGER-502') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'gateway_error' })); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'ok', app: 'bcb', agent_served: 'main', reply: 'This made my morning too — five calm minutes really do set the tone. Keep it going!' }));
        }
        if (req.url === '/v1/batch' && req.method === 'POST' && req.headers.authorization === 'Bearer stub-wrapper-token') {
          stubBatchSaw = { path: req.url, body: parsedBody };
          res.writeHead(202, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'queued', job_id: 'stub-job-1', poll: '/v1/batch/stub-job-1' }));
        }
        if (req.url === '/v1/batch/stub-job-1' && req.method === 'GET' && req.headers.authorization === 'Bearer stub-wrapper-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ job_id: 'stub-job-1', app: 'bcb', status: 'done', result: '```json\n' + JSON.stringify(stubPlan) + '\n```', elapsed_s: 1 }));
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      });
    });
    await new Promise((r) => stub.listen(3461, '127.0.0.1', r));
    // Unit: the ai client itself — error codes, caps, TLS, prompt measure.
    // Fresh require with the stub's URL/token/CA/fingerprint in env.
    process.env.SOPHIA_WRAPPER_URL = 'https://127.0.0.1:3461';
    process.env.SOPHIA_WRAPPER_TOKEN = 'stub-wrapper-token';
    process.env.SOPHIA_WRAPPER_CA_PEM = stubCert;
    process.env.SOPHIA_WRAPPER_FINGERPRINT = stubFp;
    delete require.cache[require.resolve('./lib/ai')];
    const aiLive = require('./lib/ai');
    assert.strictEqual(aiLive.isWrapperConfigured(), true, 'wrapper must report configured with https URL + token');
    assert.strictEqual(aiLive.PROMPT_MAX_CHARS, 8000, 'prompt cap must be 8000');
    assert.strictEqual(aiLive.WRAPPER_CHAT_TIMEOUT_S, 120, 'wrapper chat timeout must be 120s');
    assert.strictEqual(aiLive.CLIENT_TIMEOUT_SLACK_MS, 30000, 'client abort must sit 30s past the wrapper timeout');
    assert.ok(aiLive.BATCH_SUBMIT_TIMEOUT_MS < aiLive.WRAPPER_BATCH_TIMEOUT_S * 1000, 'batch submit abort must not race the batch job timeout');
    const errCode = async (message) => {
      try { await aiLive.callWrapperChat({ message }); throw new Error('should have thrown for ' + message); }
      catch (e) { if (e.message.startsWith('should have thrown')) throw e; return e; }
    };
    let ee = await errCode('TRIGGER-401');
    assert.strictEqual(ee.code, 'unauthorized', '401 must map to unauthorized, got: ' + ee.code);
    ee = await errCode('TRIGGER-429');
    assert.strictEqual(ee.code, 'rate_limited', '429 must map to rate_limited, got: ' + ee.code);
    assert.strictEqual(ee.retryAfterSec, 42, '429 must honour Retry-After, got: ' + ee.retryAfterSec);
    ee = await errCode('TRIGGER-503');
    assert.strictEqual(ee.code, 'ram_gated', '503 must map to ram_gated, got: ' + ee.code);
    ee = await errCode('TRIGGER-502');
    assert.strictEqual(ee.code, 'gateway_error', '502 must map to gateway_error, got: ' + ee.code);
    // Defect (d): 8000-char cap enforced client-side on BOTH paths.
    ee = await (async () => { try { await aiLive.callWrapperChat({ message: 'x'.repeat(8001) }); throw new Error('no-throw'); } catch (e) { return e; } })();
    assert.strictEqual(ee.code, 'prompt_too_long', 'chat over 8000 chars must fail client-side, got: ' + ee.code);
    ee = await (async () => { try { await aiLive.callWrapperBatch({ task: 'plan_video', prompt: 'x'.repeat(8001) }); throw new Error('no-throw'); } catch (e) { return e; } })();
    assert.strictEqual(ee.code, 'prompt_too_long', 'batch over 8000 chars must fail client-side, got: ' + ee.code);
    // Defect (a): no CA PEM -> tls_ca_missing (nothing is sent); wrong
    // fingerprint -> tls_mismatch (the handshake is refused).
    delete process.env.SOPHIA_WRAPPER_CA_PEM;
    delete require.cache[require.resolve('./lib/ai')];
    const aiNoPem = require('./lib/ai');
    ee = await (async () => { try { await aiNoPem.callWrapperChat({ message: 'hi' }); throw new Error('no-throw'); } catch (e) { return e; } })();
    assert.strictEqual(ee.code, 'tls_ca_missing', 'missing CA PEM must fail as tls_ca_missing, got: ' + ee.code + ' ' + ee.message);
    process.env.SOPHIA_WRAPPER_CA_PEM = stubCert;
    process.env.SOPHIA_WRAPPER_FINGERPRINT = '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
    delete require.cache[require.resolve('./lib/ai')];
    const aiBadFp = require('./lib/ai');
    ee = await (async () => { try { await aiBadFp.callWrapperChat({ message: 'hi' }); throw new Error('no-throw'); } catch (e) { return e; } })();
    assert.strictEqual(ee.code, 'tls_mismatch', 'wrong fingerprint must fail as tls_mismatch, got: ' + ee.code + ' ' + ee.message);
    // Restore the good fingerprint for the app server below.
    process.env.SOPHIA_WRAPPER_FINGERPRINT = stubFp;
    // Defect (c): measure a real enriched job — big portfolio + latest plan.
    const bigJob = { id: 'measure-1', type: 'plan_video', payload: { client: { id: 'c1', name: 'AI Client', approvalMode: 'professional_default' }, lockedNiche: { niche: 'Morning home resets', pillars: ['5-minute reset', 'home tips'], format: 'Short vertical tips', promise: 'One calm, doable reset per video', version: 1, status: 'agreed' }, portfolio: Array.from({ length: 30 }, (_, i) => ({ text: `Portfolio item ${i} — a long description of a morning reset video with many details about the routine, the home, the light, the calm, and the outcome for the viewer. `.repeat(3), links: 'https://example.com/' + i, outcome: 'grew the series' })), video: { id: 'v1', title: '5-minute morning reset', topic: 'Morning reset', promise: 'One calm reset' }, latestPlan: { title: 'old plan', script: { hook: 'h'.repeat(500), beats: ['b'.repeat(500)], cta: 'c' }, captions: ['x'.repeat(500)], thumbnail: 'thumb' } } };
    const measured = aiLive.buildBatchPrompt('plan_video', bigJob);
    assert.ok(measured.chars <= 8000, `compacted batch prompt must fit 8000 chars, got ${measured.chars}`);
    assert.strictEqual(measured.compacted, true, 'big enriched job must compact');
    assert.ok(measured.dropped.length > 0, 'compaction must record what it dropped');
    assert.ok(measured.prompt.includes('Morning home resets'), 'compaction must never drop the locked niche');
    assert.ok(measured.prompt.includes('5-minute morning reset'), 'compaction must never drop the video');
    const smallJob = { id: 'measure-2', type: 'plan_video', payload: { client: { id: 'c1', name: 'AI Client' }, lockedNiche: { niche: 'Morning home resets', pillars: ['5-minute reset'], format: 'Short', promise: 'One calm reset', version: 1, status: 'agreed' }, portfolio: [], video: { id: 'v1', title: '5-minute morning reset', topic: 'Morning reset', promise: 'One calm reset' } } };
    const small = aiLive.buildBatchPrompt('plan_video', smallJob);
    assert.strictEqual(small.compacted, false, 'small enriched job must not compact');
    assert.ok(small.chars > 0 && small.chars <= 8000, `small prompt must fit, got ${small.chars}`);
    // extractBatchJson: the wrapper returns plain text — fenced JSON out.
    const extracted = aiLive.extractBatchJson('some preamble\n```json\n{"title":"T"}\n```\ntrailing');
    assert.strictEqual(extracted.title, 'T', 'extractBatchJson must pull the fenced object');
    console.log(`AI client unit OK: error codes (401/429+Retry-After 42/502/503), caps, TLS (no-PEM + bad-fingerprint), prompt measure (big job ${measured.chars} chars compacted, small ${small.chars})`);
    const port4 = 3460;
    const child4 = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port4), DATA_FILE: '/tmp/vp-wrapper-test-data.json', BCB_AI_TOKEN: 'test-ai-token', SOPHIA_SERVICE_TOKEN: 'test-service-token', SOPHIA_WRAPPER_URL: 'https://127.0.0.1:3461', SOPHIA_WRAPPER_TOKEN: 'stub-wrapper-token', SOPHIA_WRAPPER_CA_PEM: stubCert, SOPHIA_WRAPPER_FINGERPRINT: stubFp }, stdio: 'pipe' });
    const base4 = `http://127.0.0.1:${port4}`;
    try {
      for (let i = 0; i < 50; i++) { try { const r = await fetch(base4 + '/api/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
      const api4 = async (path, method, body, token) => {
        const r = await fetch(base4 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`); return j;
      };
      await api4('/api/setup', 'POST', { password: 'pw44' });
      const login4 = await api4('/api/login', 'POST', { password: 'pw44' });
      const ct4 = login4.token;
      const st4 = await api4('/api/coordinator/ai/status', 'GET', null, ct4);
      assert.strictEqual(st4.mode, 'live-via-wrapper', 'status must report live-via-wrapper when the wrapper is configured');
      const wc = await api4('/api/coordinator/clients', 'POST', { name: 'Wrapper Client', email: 'w@example.com' }, ct4);
      const wred = await api4('/api/redeem', 'POST', { code: wc.code.code });
      const wn = await api4(`/api/coordinator/clients/${wc.client.id}/niche`, 'POST', { niche: 'Morning home resets', pillars: ['5-minute reset'], format: 'Short vertical tips', promise: 'One calm reset', confidence: 'high' }, ct4);
      await api4(`/api/client/niches/${wn.niche.id}/decision`, 'POST', { decision: 'agree' }, wred.token);
      const wv = await api4('/api/client/videos', 'POST', { title: '5-minute morning reset', topic: 'Morning reset', promise: 'One calm reset' }, wred.token);
      const live = await api4(`/api/videos/${wv.video.id}/reply`, 'POST', { comment: 'This reset routine actually works!', commenter: 'homefan22' }, ct4);
      assert.ok(live.reply, 'live wrapper reply must come back synchronously');
      assert.strictEqual(live.reply.aiGenerated, true, 'wrapper-drafted reply must be aiGenerated:true');
      assert.strictEqual(live.reply.model, 'sophia-wrapper-live');
      assert.ok(live.reply.text.includes('five calm minutes'), 'reply text must be the model text from the wrapper');
      assert.strictEqual(stubSaw.path, '/v1/chat', 'app must call the wrapper chat route');
      assert.strictEqual(stubSaw.body.app, 'bcb', 'chat body must name app bcb');
      assert.strictEqual(stubSaw.body.agent, 'main', 'chat must use agent main until the BCB agent is provisioned');
      assert.ok(stubSaw.body.user_id, 'chat body must carry a user_id');
      assert.ok(stubSaw.body.message.includes('This reset routine actually works!'), 'chat message must carry the comment');
      console.log('Live wrapper path (stub, real contract shape) OK:', JSON.stringify(live.reply.text));
      // App-side wrapper-batch poller (defect (c)): enqueue a plan job
      // with the wrapper configured — the poller submits it to the stub
      // /v1/batch and the stub plan lands in aiPlans[] with no runner.
      const wj = await api4('/api/coordinator/ai/jobs', 'POST', { type: 'plan_video', videoId: wv.video.id }, ct4);
      assert.strictEqual(wj.job.status, 'queued', 'wrapper-batch job must start queued');
      let wjDone = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const g = await api4(`/api/coordinator/ai/jobs/${wj.job.id}`, 'GET', null, ct4);
        if (g.job.status === 'done' || g.job.status === 'failed') { wjDone = g.job; break; }
      }
      assert.ok(wjDone, 'wrapper-batch job must reach a terminal state');
      assert.strictEqual(wjDone.status, 'done', 'wrapper-batch job must finish done, got: ' + JSON.stringify(wjDone));
      assert.ok(stubBatchSaw && stubBatchSaw.body.app === 'bcb', 'poller must submit to POST /v1/batch as app bcb');
      assert.ok(stubBatchSaw.body.prompt.length <= 8000, 'submitted batch prompt must fit the 8000 cap, got ' + stubBatchSaw.body.prompt.length);
      assert.ok(stubBatchSaw.body.prompt.includes('Morning home resets'), 'submitted prompt must carry the locked niche');
      assert.ok(stubBatchSaw.body.prompt.includes('5-minute morning reset'), 'submitted prompt must carry the video');
      const wplans = await api4('/api/coordinator/ai/plans?videoId=' + wv.video.id, 'GET', null, ct4);
      assert.strictEqual(wplans.plans.length, 1, 'poller-ingested plan must be readable from the app');
      assert.strictEqual(wplans.plans[0].title, '5-minute morning reset');
      assert.strictEqual(wjDone.result.model, 'sophia-wrapper-batch', 'poller result must be stamped sophia-wrapper-batch');
      console.log('Wrapper-batch poller (stub /v1/batch, submit -> poll -> ingest) OK');
    } finally { child4.kill(); stub.close(); try { fs.unlinkSync('/tmp/vp-wrapper-test-data.json'); } catch {} try { fs.unlinkSync(stubCert); } catch {} try { fs.unlinkSync(stubKey); } catch {} }
    // ---- Wave 2C: desk UI + storage + SLA + reply/plan state machines + trend feed ----
    // Unit: SLA arithmetic with fixed times.
    assert.strictEqual(SLA_MS, 3 * 24 * 3600 * 1000, 'SLA must be 3 days');
    const t0 = new Date('2026-11-17T12:00:00Z').getTime();
    const slaBase = slaInfo({ deadlineAt: new Date(t0 + SLA_MS).toISOString(), pausedAt: null, pausedMsTotal: 0 }, t0);
    assert.strictEqual(slaBase.pausedMs, 0, 'unpaused video must show 0 paused ms');
    assert.strictEqual(slaBase.deadlineActiveAt, new Date(t0 + SLA_MS).toISOString(), 'unpaused deadline must not move');
    assert.strictEqual(slaBase.overdue, false);
    const slaPaused = slaInfo({ deadlineAt: new Date(t0 + SLA_MS).toISOString(), pausedAt: new Date(t0 + 3600000).toISOString(), pausedMsTotal: 7200000 }, t0 + 3600000 + 1800000);
    assert.strictEqual(slaPaused.pausedMs, 9000000, 'paused total 2h + currently paused 30m must be 2.5h');
    assert.strictEqual(slaPaused.deadlineActiveAt, new Date(t0 + SLA_MS + 9000000).toISOString(), 'active deadline must move by exactly the paused time');
    const slaOver = slaInfo({ deadlineAt: new Date(t0 + 1000).toISOString(), pausedAt: null, pausedMsTotal: 0 }, t0 + 2000);
    assert.strictEqual(slaOver.overdue, true, 'past active deadline must be overdue');
    console.log('SLA unit (fixed times) OK');

    // Unit: plan diff + trend-feed helpers.
    const dp = diffPlan({ title: 'A', script: { hook: 'h1', beats: ['b1'], cta: 'c' }, captions: ['x'], thumbnail: 't' }, { title: 'B', script: { hook: 'h1', beats: ['b1', 'b2'], cta: 'c' }, captions: ['x'], thumbnail: 't' });
    assert.deepStrictEqual(dp.changed.sort(), ['script.beats', 'title']);
    assert.deepStrictEqual(diffPlan(null, { title: 'B' }), { previousVersion: null, changed: [] });
    const nw1 = normalizeWatchItem({ platform: 'TikTok', change: 'New editing tools', source: 'socialmediatoday.com' }, '2026-11-17T00:00:00Z');
    assert.strictEqual(nw1.platform, 'tiktok');
    assert.strictEqual(nw1.claim, 'New editing tools');
    assert.strictEqual(nw1.sourceGrade, 'sourced');
    assert.strictEqual(nw1.source, 'socialmediatoday.com');
    const nw2 = normalizeWatchItem({ platform: 'instagram', claim: 'Something changed' }, '2026-11-17T00:00:00Z');
    assert.strictEqual(nw2.sourceGrade, 'unverified', 'an item with no source must be graded unverified');
    assert.deepStrictEqual(nw2.affectsClients, []);
    const wd = diffWatchEditions([nw1], [nw1, nw2]);
    assert.strictEqual(wd.added.length, 1, 'second edition must add exactly the new item');
    assert.strictEqual(wd.removed.length, 0);
    const wd2 = diffWatchEditions([nw1, nw2], [nw2]);
    assert.strictEqual(wd2.removed.length, 1, 'dropping an item must show as removed');
    const ff0 = feedFreshness([]);
    assert.strictEqual(ff0.status, 'never', 'no editions must report never checked');
    const ff1 = feedFreshness([{ createdAt: '2026-11-17T00:00:00Z' }], new Date('2026-11-18T00:00:00Z').getTime());
    assert.strictEqual(ff1.status, 'current');
    assert.strictEqual(ff1.nextCheckAt, '2026-11-24T00:00:00.000Z', 'next check must be last check + 7 days');
    const ff2 = feedFreshness([{ createdAt: '2026-11-01T00:00:00Z' }], new Date('2026-11-17T00:00:00Z').getTime());
    assert.strictEqual(ff2.status, 'overdue', 'a check more than 7 days old must be overdue');
    console.log('Plan diff + trend-feed helpers OK');

    // Unit: storage — two concurrent updateDb writes must both land; a
    // stale putDb must fail loudly instead of silently overwriting.
    // (This process's DATA_FILE is /tmp/vp-oauth-unit-data.json; the
    // TikTok section deleted it, so this starts from an empty db.)
    try { fs.unlinkSync('/tmp/vp-oauth-unit-data.json'); } catch {}
    await updateDb((d) => { d.clients.push({ id: 'u1', name: 'Unit One' }); return 'u1'; });
    await Promise.all([
      updateDb((d) => { d.clients.push({ id: 'u2', name: 'Unit Two' }); }),
      updateDb((d) => { d.clients.push({ id: 'u3', name: 'Unit Three' }); }),
    ]);
    const freshUnit = await loadFreshDb();
    assert.ok(freshUnit.clients.some((c) => c.id === 'u1'), 'first updateDb write must land');
    assert.ok(freshUnit.clients.some((c) => c.id === 'u2'), 'concurrent updateDb write 1 must land');
    assert.ok(freshUnit.clients.some((c) => c.id === 'u3'), 'concurrent updateDb write 2 must land');
    const storedUnit = JSON.parse(fs.readFileSync('/tmp/vp-oauth-unit-data.json', 'utf8'));
    storedUnit._rev = (storedUnit._rev || 0) + 5;
    fs.writeFileSync('/tmp/vp-oauth-unit-data.json', JSON.stringify(storedUnit));
    let threw = null;
    try { await putDb(); } catch (e) { threw = e; }
    assert.ok(threw && threw.name === 'VersionConflictError', 'stale putDb must throw VersionConflictError, got: ' + (threw && threw.name));
    const afterStale = JSON.parse(fs.readFileSync('/tmp/vp-oauth-unit-data.json', 'utf8'));
    assert.strictEqual(afterStale._rev, storedUnit._rev, 'failed save must not touch the stored db');
    try { fs.unlinkSync('/tmp/vp-oauth-unit-data.json'); } catch {}
    console.log('Storage unit (concurrent updateDb both land; stale putDb fails loud) OK');

    // ---- Wave 2C integration server (port 3462) ----
    const port5 = 3462;
    const child5 = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port5), DATA_FILE: '/tmp/vp-2c-test-data.json', BCB_AI_TOKEN: 'test-ai-token', SOPHIA_SERVICE_TOKEN: 'test-service-token', SOPHIA_WRAPPER_URL: '', SOPHIA_WRAPPER_TOKEN: '', SOPHIA_WRAPPER_CA_PEM: '', SOPHIA_WRAPPER_FINGERPRINT: '' }, stdio: 'pipe' });
    const base5 = `http://127.0.0.1:${port5}`;
    try {
      for (let i = 0; i < 50; i++) { try { const r = await fetch(base5 + '/api/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
      const api5 = async (path, method, body, token) => {
        const r = await fetch(base5 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`); return j;
      };
      const api5err = async (path, method, body, token) => {
        const r = await fetch(base5 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      await api5('/api/setup', 'POST', { password: 'pw55' });
      const login5 = await api5('/api/login', 'POST', { password: 'pw55' });
      const ct5 = login5.token;
      const c5 = await api5('/api/coordinator/clients', 'POST', { name: 'Wave2C Client', email: 'w2c@example.com' }, ct5);
      const red5 = await api5('/api/redeem', 'POST', { code: c5.code.code });
      const n5 = await api5(`/api/coordinator/clients/${c5.client.id}/niche`, 'POST', { niche: 'Morning home resets', pillars: ['5-minute reset', 'home tips'], format: 'Short vertical tips', promise: 'One calm reset per video', confidence: 'high' }, ct5);
      await api5(`/api/client/niches/${n5.niche.id}/decision`, 'POST', { decision: 'agree' }, red5.token);
      const v5 = await api5('/api/client/videos', 'POST', { title: '5-minute morning reset', topic: 'Morning reset', promise: 'One calm reset', series: 'Morning Reset', episode: '12' }, red5.token);
      assert.strictEqual(v5.video.pausedAt, null, 'new video must start unpaused');
      assert.strictEqual(v5.video.pausedMsTotal, 0, 'new video must start with 0 paused ms');

      // SLA pause via HTTP: block -> wait -> unblock moves the deadline by exactly the paused time.
      const blocked = await api5(`/api/videos/${v5.video.id}/block`, 'POST', { reason: 'waiting on client files', owner: 'coordinator' }, ct5);
      assert.ok(blocked.video.pausedAt, 'block must set pausedAt');
      assert.strictEqual(blocked.video.blockedReason, 'waiting on client files');
      assert.strictEqual(blocked.video.blockedOwner, 'coordinator');
      const deadlineBefore = new Date(blocked.video.deadlineAt).getTime();
      await new Promise((r) => setTimeout(r, 300));
      const blocked2 = await api5(`/api/videos/${v5.video.id}/block`, 'POST', { reason: 'still waiting', owner: 'coordinator' }, ct5);
      assert.strictEqual(blocked2.video.pausedAt, blocked.video.pausedAt, 'a second block must not reset pausedAt');
      await new Promise((r) => setTimeout(r, 1200));
      const unblocked = await api5(`/api/videos/${v5.video.id}/unblock`, 'POST', {}, ct5);
      assert.strictEqual(unblocked.video.pausedAt, null, 'unblock must clear pausedAt');
      const pausedMs = unblocked.video.pausedMsTotal;
      assert.ok(pausedMs >= 1200 && pausedMs < 3000, `pausedMsTotal must be ~the waited time, got ${pausedMs}`);
      const movedMs = new Date(unblocked.sla.deadlineActiveAt).getTime() - deadlineBefore;
      assert.strictEqual(movedMs, pausedMs, `active deadline must move by exactly the paused time (moved ${movedMs} vs paused ${pausedMs})`);
      assert.strictEqual(unblocked.sla.pausedMsTotal, pausedMs);
      const unblockAgain = await api5err(`/api/videos/${v5.video.id}/unblock`, 'POST', {}, ct5);
      assert.strictEqual(unblockAgain.status, 400, 'unblocking an unblocked video must 400');
      console.log(`SLA pause via HTTP OK: paused ${pausedMs}ms, deadline moved ${movedMs}ms`);

      // Reply state machine: AI draft lands as draft; approve -> post; bad transitions 400.
      const drJob = await api5('/api/coordinator/ai/jobs', 'POST', { type: 'draft_reply', videoId: v5.video.id }, ct5);
      const ingR = await api5(`/api/ai/jobs/${drJob.job.id}/result`, 'POST', { status: 'done', result: { reply: 'Draft reply for the state machine test.', model: 'claude-code-batch', nicheCheck: { pass: true, score: 1, matched: ['morning'], reason: 'on-niche' } } }, 'test-ai-token');
      const replyId = ingR.job.result.replyId;
      let reps = await api5(`/api/videos/${v5.video.id}/replies`, 'GET', null, ct5);
      const draft = reps.replies.find((r) => r.id === replyId);
      assert.ok(draft && draft.status === 'draft', 'AI-drafted reply must land as draft, got: ' + JSON.stringify(draft));
      let badT = await api5err(`/api/videos/${v5.video.id}/replies/${replyId}/post`, 'POST', {}, ct5);
      assert.strictEqual(badT.status, 400, 'posting a draft without approval must 400');
      const appr = await api5(`/api/videos/${v5.video.id}/replies/${replyId}/approve`, 'POST', {}, ct5);
      assert.strictEqual(appr.reply.status, 'approved');
      badT = await api5err(`/api/videos/${v5.video.id}/replies/${replyId}/approve`, 'POST', {}, ct5);
      assert.strictEqual(badT.status, 400, 'approving an approved reply must 400');
      const posted = await api5(`/api/videos/${v5.video.id}/replies/${replyId}/post`, 'POST', {}, ct5);
      assert.strictEqual(posted.reply.status, 'posted');
      assert.strictEqual(posted.reply.postedChannel, 'manual', 'desk "posted" must be recorded as manual until a platform API exists');
      const drJob2 = await api5('/api/coordinator/ai/jobs', 'POST', { type: 'draft_reply', videoId: v5.video.id }, ct5);
      await api5(`/api/ai/jobs/${drJob2.job.id}/result`, 'POST', { status: 'done', result: { reply: 'Second draft to reject.', model: 'claude-code-batch' } }, 'test-ai-token');
      reps = await api5(`/api/videos/${v5.video.id}/replies`, 'GET', null, ct5);
      const draft2 = reps.replies.find((r) => r.text === 'Second draft to reject.');
      const rej = await api5(`/api/videos/${v5.video.id}/replies/${draft2.id}/reject`, 'POST', { reason: 'off-brand' }, ct5);
      assert.strictEqual(rej.reply.status, 'rejected');
      assert.strictEqual(rej.reply.rejectionReason, 'off-brand');
      const cr2 = await api5(`/api/videos/${v5.video.id}/reply`, 'POST', { text: 'Posted by hand.' }, ct5);
      assert.strictEqual(cr2.reply.status, 'posted', 'coordinator text must land as posted');
      console.log('Reply state machine (draft -> approve -> post, reject) OK');

      // Plan versions: v1 approved stays approved when v2 arrives; approving v2 supersedes v1.
      const pj1 = await api5('/api/coordinator/ai/jobs', 'POST', { type: 'plan_video', videoId: v5.video.id }, ct5);
      await api5(`/api/ai/jobs/${pj1.job.id}/result`, 'POST', { status: 'done', result: { title: 'Plan A', script: { hook: 'hook A', beats: ['b1'], cta: 'cta A' }, captions: ['cap A'], thumbnail: { direction: 'morning' }, nicheCheck: { verdict: 'pass', reasons: ['on-niche'] } } }, 'test-ai-token');
      let plans = await api5('/api/coordinator/ai/plans?videoId=' + v5.video.id, 'GET', null, ct5);
      assert.strictEqual(plans.plans.length, 1);
      assert.strictEqual(plans.plans[0].version, 1);
      assert.strictEqual(plans.plans[0].status, 'draft');
      assert.strictEqual(plans.plans[0].diffVs.previousVersion, null, 'first version must have no previous version');
      const ap1 = await api5(`/api/coordinator/ai/plans/${plans.plans[0].id}/approve`, 'POST', {}, ct5);
      assert.strictEqual(ap1.plan.status, 'approved');
      const pj2 = await api5('/api/coordinator/ai/jobs', 'POST', { type: 'plan_video', videoId: v5.video.id }, ct5);
      await api5(`/api/ai/jobs/${pj2.job.id}/result`, 'POST', { status: 'done', result: { title: 'Plan B', script: { hook: 'hook B', beats: ['b1'], cta: 'cta A' }, captions: ['cap A'], thumbnail: { direction: 'morning' }, nicheCheck: { verdict: 'pass', reasons: ['on-niche'] } } }, 'test-ai-token');
      plans = await api5('/api/coordinator/ai/plans?videoId=' + v5.video.id, 'GET', null, ct5);
      assert.strictEqual(plans.plans.length, 2);
      const v1 = plans.plans.find((x) => x.version === 1);
      const v2 = plans.plans.find((x) => x.version === 2);
      assert.strictEqual(v1.status, 'approved', 'approved v1 must stay approved when v2 arrives — no silent overwrite');
      assert.strictEqual(v2.status, 'draft');
      assert.strictEqual(v2.diffVs.previousVersion, 1);
      assert.deepStrictEqual(v2.diffVs.changed, ['title', 'script.hook'], 'diff must list exactly the changed fields, got: ' + JSON.stringify(v2.diffVs.changed));
      const ap2 = await api5(`/api/coordinator/ai/plans/${v2.id}/approve`, 'POST', {}, ct5);
      assert.strictEqual(ap2.plan.status, 'approved');
      plans = await api5('/api/coordinator/ai/plans?videoId=' + v5.video.id, 'GET', null, ct5);
      assert.strictEqual(plans.plans.find((x) => x.version === 1).status, 'superseded', 'approving v2 must supersede v1');
      assert.strictEqual(plans.plans.find((x) => x.version === 1).supersededBy, v2.id);
      const pj3 = await api5('/api/coordinator/ai/jobs', 'POST', { type: 'plan_video', videoId: v5.video.id }, ct5);
      await api5(`/api/ai/jobs/${pj3.job.id}/result`, 'POST', { status: 'done', result: { title: 'Plan C', script: { hook: 'h', beats: ['b'], cta: 'c' }, nicheCheck: { verdict: 'pass', reasons: [] } } }, 'test-ai-token');
      plans = await api5('/api/coordinator/ai/plans?videoId=' + v5.video.id, 'GET', null, ct5);
      const v3 = plans.plans.find((x) => x.version === 3);
      const rj3 = await api5(`/api/coordinator/ai/plans/${v3.id}/reject`, 'POST', { reason: 'wrong tone' }, ct5);
      assert.strictEqual(rj3.plan.status, 'rejected');
      assert.strictEqual(rj3.plan.rejectionReason, 'wrong tone');
      console.log('Plan versions (v1 approved survives v2; approve supersedes; reject) OK');

      // Trend feed: normalize + diff + freshness via ingest; desk aggregate.
      const wj1 = await api5('/api/coordinator/ai/jobs', 'POST', { type: 'network_watch' }, ct5);
      await api5(`/api/ai/jobs/${wj1.job.id}/result`, 'POST', { status: 'done', result: {
        weekOf: '2026-11-16',
        platformChanges: [
          { platform: 'Instagram', claim: 'Edits adds speed curves', sourceUrl: 'https://socialmediatoday.com/x', sourceGrade: 'sourced', publishedAt: '2026-11-12', observedAt: '2026-11-17T00:00:00Z', affectsClients: [c5.client.id], action: 'Try speed curves on the next reset video' },
          { platform: 'tiktok', change: 'Shop Plus testing', source: 'socialmediatoday.com' },
          { platform: 'youtube', claim: 'Unverified rumour item' },
        ],
        trends: [], perClient: [], unverified: ['Unverified rumour item'],
      } }, 'test-ai-token');
      let watch = await api5('/api/coordinator/ai/watch', 'GET', null, ct5);
      assert.strictEqual(watch.watch.length, 1);
      const ed1 = watch.watch[0];
      assert.strictEqual(ed1.items.length, 3, 'all three raw changes must normalize to feed items');
      assert.strictEqual(ed1.items[0].platform, 'instagram');
      assert.strictEqual(ed1.items[0].sourceGrade, 'sourced');
      assert.deepStrictEqual(ed1.items[0].affectsClients, [c5.client.id]);
      assert.strictEqual(ed1.items[1].claim, 'Shop Plus testing', 'legacy change/source shape must normalize');
      assert.strictEqual(ed1.items[1].sourceGrade, 'sourced');
      assert.strictEqual(ed1.items[2].sourceGrade, 'unverified', 'an item with no source must be graded unverified');
      assert.strictEqual(ed1.diff.added.length, 3, 'first edition: everything is added');
      assert.ok(watch.freshness.lastCheckedAt, 'freshness must stamp last checked');
      assert.strictEqual(watch.freshness.status, 'current');
      const wj2 = await api5('/api/coordinator/ai/jobs', 'POST', { type: 'network_watch' }, ct5);
      await api5(`/api/ai/jobs/${wj2.job.id}/result`, 'POST', { status: 'done', result: {
        weekOf: '2026-11-23',
        platformChanges: [
          { platform: 'Instagram', claim: 'Edits adds speed curves', sourceUrl: 'https://socialmediatoday.com/x', sourceGrade: 'sourced', publishedAt: '2026-11-12', observedAt: '2026-11-24T00:00:00Z', affectsClients: [c5.client.id] },
          { platform: 'youtube', claim: 'New Shorts editing tools', sourceUrl: 'https://youtube.com/blog', sourceGrade: 'sourced', publishedAt: '2026-11-20', observedAt: '2026-11-24T00:00:00Z', affectsClients: [] },
        ],
        trends: [], perClient: [], unverified: [],
      } }, 'test-ai-token');
      watch = await api5('/api/coordinator/ai/watch', 'GET', null, ct5);
      assert.strictEqual(watch.watch.length, 2);
      const ed2 = watch.watch[0];
      assert.strictEqual(ed2.diff.added.length, 1, 'second edition must add exactly one item');
      assert.strictEqual(ed2.diff.removed.length, 2, 'second edition must drop two items');
      assert.strictEqual(ed2.diff.added[0].claim, 'New Shorts editing tools');
      console.log('Trend feed (schema, grades, diff, freshness) OK');

      // Desk aggregate + desk page render (DOM checks, not a claim).
      const desk = await api5('/api/coordinator/desk', 'GET', null, ct5);
      assert.ok(Array.isArray(desk.videos) && desk.videos.length >= 1, 'desk must list videos');
      assert.ok(desk.videos[0].sla && desk.videos[0].sla.deadlineActiveAt, 'desk videos must carry SLA info');
      assert.ok(Array.isArray(desk.replies) && desk.replies.length >= 1, 'desk must list replies');
      assert.ok(desk.replies.every((r) => ['draft', 'approved', 'posted', 'rejected'].includes(r.status)), 'every desk reply must carry a state-machine status');
      assert.ok(Array.isArray(desk.jobs) && desk.jobs.length >= 1);
      assert.ok(desk.jobs.every((j) => ['queued', 'running', 'done', 'failed', 'gated'].includes(j.status)), 'every desk job must carry an honest status');
      assert.ok(Array.isArray(desk.plans) && desk.plans.length >= 3, 'desk must list the versioned plans');
      assert.ok(Array.isArray(desk.watch) && desk.watch.length === 2, 'desk must list the watch editions');
      assert.ok(desk.freshness && desk.freshness.lastCheckedAt, 'desk must carry the feed freshness stamp');
      assert.strictEqual(desk.ai.mode, 'batch-only', 'desk must report batch-only without a wrapper');
      const deskPage = await fetch(base5 + '/desk');
      assert.strictEqual(deskPage.status, 200, 'GET /desk must serve the desk page');
      const deskHtml = await deskPage.text();
      for (const id of ['sec-sla', 'sec-replies', 'sec-jobs', 'sec-plans', 'sec-watch', 'feedFreshness', 'slaList', 'replyList', 'jobList', 'planList', 'watchList']) {
        assert.ok(deskHtml.includes(`id="${id}"`), `desk page must contain #${id}`);
      }
      assert.ok(deskHtml.includes('SLA queue') && deskHtml.includes('Trend feed'), 'desk page must render the SLA and feed headings');
      const deskNoAuth = await fetch(base5 + '/api/coordinator/desk');
      assert.strictEqual(deskNoAuth.status, 401, 'desk aggregate must require coordinator login');
      console.log('Desk aggregate + /desk page OK');
    } finally { child5.kill(); try { fs.unlinkSync('/tmp/vp-2c-test-data.json'); } catch {} }

    // ---- Wave 2D: publish worker + scheduler + comment intake + replies ----
    // Unit first (no server), then a dedicated child server (port 3465)
    // with the webhook + worker secrets set.
    {
      const crypto = require('crypto');
      const fs2 = require('fs');
      // Publish records + adapter refusals (zero adapters: every
      // platform refuses honestly, with the exact missing item named).
      const rec = publish.newPublishRecord('tiktok', { scheduledFor: null });
      assert.strictEqual(rec.status, 'scheduled');
      assert.ok(/^[0-9a-f]{32}$/.test(rec.idempotencyKey), 'idempotency key must be 32 hex chars, got: ' + rec.idempotencyKey);
      assert.strictEqual(rec.maxAttempts, 3, 'retry floor is 3 attempts');
      assert.strictEqual(rec.retryIntervalMs, 10 * 60 * 1000, 'retry floor is 10-minute intervals');
      assert.notStrictEqual(publish.newPublishRecord('tiktok').idempotencyKey, rec.idempotencyKey, 'each attempt gets its own idempotency key');
      for (const pl of publish.PLATFORMS) {
        const refusal = publish.adapterRefusal(pl);
        assert.ok(refusal, `${pl} must refuse while its adapter is not enabled`);
        assert.ok(/not enabled|not wired/i.test(refusal.message), `${pl} refusal must say why, got: ${refusal.message}`);
      }
      assert.ok(/video\.upload/.test(publish.adapterRefusal('tiktok').message), 'TikTok refusal must name the video.upload scope widening');
      assert.ok(/100 videos\.insert/.test(publish.adapterRefusal('youtube').message), 'YouTube refusal must carry the corrected 100/day quota');
      assert.ok(/content_publishing_limit/.test(publish.adapterRefusal('instagram').message), 'Instagram refusal must name the runtime quota check');
      console.log('Publish records + adapter refusals (zero adapters, honest reasons) OK');

      // Error classification: auth is a reconnect state, never a retry.
      assert.strictEqual(publish.classifyPlatformError('facebook', { code: 190, message: 'Error validating access token' }).kind, 'auth');
      assert.strictEqual(publish.classifyPlatformError('facebook', { code: 190, message: 'x' }).retryable, false, 'FB 190 must not be retried as a publish attempt');
      assert.strictEqual(publish.classifyPlatformError('youtube', { code: 429, message: 'rate limit exceeded' }).kind, 'rate_limit');
      assert.strictEqual(publish.classifyPlatformError('youtube', { code: 429, message: 'x' }).retryable, true);
      assert.strictEqual(publish.classifyPlatformError('tiktok', new Error('timeout — try again')).retryable, true);

      // TikTok adapter: disabled -> refuses BEFORE any network call.
      let httpCalls = 0;
      const boomHttp = { postJson: async () => { httpCalls += 1; throw new Error('must not be called'); }, getJson: async () => { httpCalls += 1; throw new Error('must not be called'); } };
      try {
        await publish.tiktokAdapter.publish({ video: { title: 'x' }, fileUrl: 'https://example.com/v.mp4', token: { accessToken: 'tok' }, attempt: {}, http: boomHttp });
        throw new Error('disabled TikTok adapter should have refused');
      } catch (e) { assert.ok(e instanceof publish.AdapterNotEnabledError, 'disabled adapter must throw AdapterNotEnabledError, got: ' + e.name); }
      assert.strictEqual(httpCalls, 0, 'disabled adapter must make zero network calls');

      // TikTok publishViaApi with mock transport: NEVER confirmed
      // without PUBLISH_COMPLETE — init alone proves nothing.
      const mkHttp = (statuses) => {
        let i = 0;
        return {
          postJson: async () => ({ data: { publish_id: 'pub-1', upload_url: 'https://example.com/up' } }),
          getJson: async () => ({ data: { status: statuses[Math.min(i++, statuses.length - 1)] } }),
        };
      };
      try {
        await publish.tiktokAdapter.publishViaApi({ video: { title: 'x' }, fileUrl: 'https://example.com/v.mp4', token: { accessToken: 'tok' }, http: { postJson: async () => ({ data: {} }), getJson: async () => ({}) } });
        throw new Error('init without publish_id should not confirm');
      } catch (e) { assert.ok(e instanceof publish.PublishNotConfirmedError, 'init without publish_id must throw PublishNotConfirmedError'); }
      try {
        await publish.tiktokAdapter.publishViaApi({ video: { title: 'x' }, fileUrl: 'https://example.com/v.mp4', token: { accessToken: 'tok' }, http: mkHttp(['FAILED']) });
        throw new Error('FAILED status should not confirm');
      } catch (e) { assert.ok(e instanceof publish.PublishNotConfirmedError && /FAILED/.test(e.message), 'FAILED status must not confirm, got: ' + e.message); }
      try {
        await publish.tiktokAdapter.publishViaApi({ video: { title: 'x' }, fileUrl: 'https://example.com/v.mp4', token: { accessToken: 'tok' }, http: mkHttp(['PUBLISHING']), pollIntervalMs: 5, pollTimeoutMs: 30 });
        throw new Error('a publish stuck at PUBLISHING should not confirm');
      } catch (e) { assert.ok(e instanceof publish.PublishNotConfirmedError && /did not complete/.test(e.message), 'stuck PUBLISHING must time out unconfirmed, got: ' + e.message); }
      const okTik = await publish.tiktokAdapter.publishViaApi({ video: { title: 'x' }, fileUrl: 'https://example.com/v.mp4', token: { accessToken: 'tok' }, http: mkHttp(['PUBLISH_COMPLETE']) });
      assert.strictEqual(okTik.confirmed, true);
      assert.strictEqual(okTik.postId, 'pub-1');
      console.log('TikTok adapter confirmation rule (init != published; only PUBLISH_COMPLETE) OK');

      // Worker attempt: transient failure retries 3x at 10-min
      // intervals, then failed; a confirming adapter writes postLinks.
      const goodToken = async () => ({ accessToken: 'tok', expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() });
      const fileUrl = async () => 'https://example.com/v.mp4';
      const transientAdapter = { publish: async () => { throw new Error('service unavailable — try again'); } };
      const t0 = Date.now();
      const vidT = { id: 'vid-t', clientId: 'c-t', title: 'Retry video', postLinks: {} };
      const recT = publish.newPublishRecord('youtube');
      let out = await publish.runPublishAttempt({ video: vidT, platform: 'youtube', record: recT, getToken: goodToken, getFileUrl: fileUrl, adapters: { youtube: transientAdapter }, nowMs: t0 });
      assert.strictEqual(out.outcome, 'error');
      assert.strictEqual(recT.attempts, 1);
      assert.strictEqual(recT.status, 'error');
      assert.strictEqual(new Date(recT.nextRetryAt).getTime(), t0 + 10 * 60 * 1000, 'next retry must be exactly 10 minutes after the attempt');
      assert.ok(recT.errorText && /YouTube/.test(recT.errorText), 'error text must name the platform in plain language');
      out = await publish.runPublishAttempt({ video: vidT, platform: 'youtube', record: recT, getToken: goodToken, getFileUrl: fileUrl, adapters: { youtube: transientAdapter }, nowMs: t0 + 10 * 60 * 1000 + 1 });
      assert.strictEqual(recT.attempts, 2);
      assert.strictEqual(recT.status, 'error');
      out = await publish.runPublishAttempt({ video: vidT, platform: 'youtube', record: recT, getToken: goodToken, getFileUrl: fileUrl, adapters: { youtube: transientAdapter }, nowMs: t0 + 20 * 60 * 1000 + 2 });
      assert.strictEqual(out.outcome, 'failed', 'third failed attempt must land in failed, not error');
      assert.strictEqual(recT.status, 'failed');
      assert.strictEqual(recT.nextRetryAt, null, 'a failed record has no next retry');
      assert.deepStrictEqual(vidT.postLinks, {}, 'postLinks must stay empty after failed attempts — never marked published');
      const recS = publish.newPublishRecord('youtube');
      const vidS = { id: 'vid-s', clientId: 'c-s', title: 'Success video', postLinks: {} };
      out = await publish.runPublishAttempt({ video: vidS, platform: 'youtube', record: recS, getToken: goodToken, getFileUrl: fileUrl, adapters: { youtube: { publish: async () => ({ confirmed: true, postId: 'yt-123', postUrl: 'https://youtube.com/watch?v=yt-123' }) } }, nowMs: t0 });
      assert.strictEqual(out.outcome, 'sent');
      assert.strictEqual(recS.status, 'sent');
      assert.strictEqual(recS.postId, 'yt-123');
      assert.strictEqual(vidS.postLinks.youtube, 'https://youtube.com/watch?v=yt-123', 'postLinks written only on confirmation');
      // Partial failure is surfaced, not hidden.
      const sum = publish.publishSummary({ id: 'v', publish: { youtube: recS, tiktok: recT } });
      assert.strictEqual(sum.sent, 1);
      assert.strictEqual(sum.failed, 1);
      assert.strictEqual(sum.partialFailure, true, '1 sent + 1 failed must flag partialFailure');
      console.log('Worker retry (3x/10min -> failed) + confirm-only postLinks + partial failure OK');

      // Token health: three-layer classification, refresh lock, death.
      assert.strictEqual(tokens.tokenHealth({ expiresAt: new Date(Date.now() - 1000).toISOString() }).status, 'expired');
      assert.strictEqual(tokens.tokenHealth({ expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }).status, 'expiring_soon');
      assert.strictEqual(tokens.tokenHealth({ expiresAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString() }).status, 'ok');
      assert.strictEqual(tokens.tokenHealth({ network: 'facebook' }).status, 'ok', 'a Facebook Page token with no expiry is healthy until the platform says otherwise');
      const sweep = tokens.sweepTokenRecords([
        { clientId: 'a', network: 'tiktok', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
        { clientId: 'b', network: 'instagram', expiresAt: new Date(Date.now() - 1000).toISOString() },
        { clientId: 'c', network: 'youtube', expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() },
      ]);
      assert.strictEqual(sweep.toRefresh.length, 1, 'only the near-expiry token is due a refresh');
      assert.strictEqual(sweep.expired.length, 1, 'only the past-expiry token is dead');
      assert.strictEqual(tokens.acquireRefreshLock('a', 'tiktok'), true);
      assert.strictEqual(tokens.acquireRefreshLock('a', 'tiktok'), false, 'a second refresh of the same row must be refused (TikTok rotation rule)');
      tokens.releaseRefreshLock('a', 'tiktok');
      assert.strictEqual(tokens.acquireRefreshLock('a', 'tiktok'), true, 'the lock must release');
      tokens.releaseRefreshLock('a', 'tiktok');
      const fakeDb = emptyDb();
      fakeDb.clients.push({ id: 'cx', name: 'X' });
      fakeDb.videos.push({ id: 'vx', clientId: 'cx', title: 'X video', publish: { tiktok: publish.newPublishRecord('tiktok') } });
      fakeDb.tiktokTokens.push({ clientId: 'cx', network: 'tiktok', expiresAt: new Date(Date.now() - 1000).toISOString() });
      const marked = tokens.markAccountExpired(fakeDb, 'cx', 'tiktok', 'TikTok token refresh failed: invalid_grant');
      assert.strictEqual(marked.recordsFailed, 1);
      assert.strictEqual(fakeDb.tiktokTokens[0].status, 'expired');
      assert.strictEqual(fakeDb.videos[0].publish.tiktok.status, 'failed');
      assert.strictEqual(fakeDb.videos[0].publish.tiktok.needsReconnect, true, 'death must surface a Reconnect flag');
      assert.ok(/invalid_grant/.test(fakeDb.videos[0].publish.tiktok.errorText), 'the failed post must carry the platform\'s own message');
      assert.ok(/Reconnect TikTok/.test(tokens.reconnectInfo('tiktok')), 'reconnect info must say what to do');
      console.log('Token health (sweep, lock, EXPIRED + FAILED + Reconnect) OK');

      // Comments: signature, keyword layer, first-hour timer.
      const secret = 'test-meta-secret';
      const rawBody = JSON.stringify({ object: 'instagram', entry: [] });
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      assert.strictEqual(comments.verifyMetaSignature({ rawBody, signature: sig, appSecret: secret }), true);
      assert.strictEqual(comments.verifyMetaSignature({ rawBody, signature: 'sha256=deadbeef', appSecret: secret }), false);
      assert.strictEqual(comments.verifyMetaSignature({ rawBody, signature: sig, appSecret: '' }), false, 'no app secret must never verify');
      assert.strictEqual(comments.matchKeyword('How much does it cost?').reply.includes('DM'), true, 'price must route to DM');
      assert.strictEqual(comments.matchKeyword('send me the link please').keyword, 'link');
      assert.strictEqual(comments.matchKeyword('is this available next week?').keyword, 'available');
      assert.strictEqual(comments.matchKeyword('more info please').keyword, 'info');
      assert.strictEqual(comments.matchKeyword('Love this reset routine!'), null, 'a plain compliment has no keyword — it goes to the AI layer');
      assert.strictEqual(comments.capReply('x'.repeat(300)).length, 280, 'AI drafts are capped at 280 chars');
      const nowMs = Date.now();
      const fh = comments.firstHourInfo({ publishedAt: new Date(nowMs - 10 * 60 * 1000).toISOString() }, nowMs);
      assert.strictEqual(fh.active, true, '10 minutes after publish must be inside the first hour');
      assert.strictEqual(new Date(fh.endsAt).getTime(), new Date(nowMs - 10 * 60 * 1000).getTime() + 60 * 60 * 1000, 'first hour must end exactly 60 minutes after publishedAt');
      assert.strictEqual(comments.firstHourInfo({ publishedAt: new Date(nowMs - 2 * 3600 * 1000).toISOString() }, nowMs).overdue, true);
      assert.strictEqual(comments.firstHourInfo({}).active, false, 'no publishedAt means no first-hour timer');
      // The network_watch prompt must tell the model web tools ARE
      // available (the wrapper passes --allowedTools for this job).
      const nwTpl = fs2.readFileSync(require('path').join(__dirname, 'lib', 'batch-prompts', 'network_watch.prompt.md'), 'utf8');
      assert.ok(nwTpl.includes('WEB TOOLS ARE AVAILABLE'), 'network_watch prompt must say web tools are available');
      assert.ok(!nwTpl.includes('WEB TOOLS ARE NOT AVAILABLE'), 'network_watch prompt must not say web tools are unavailable');
      console.log('Comments (signature, keyword layer, first-hour timer) + network_watch prompt OK');

      // Two-layer intake, unit level (the HTTP layer below proves
      // signature + dedupe; this proves the reply flow itself).
      const db2 = migrateDb(emptyDb());
      db2.clients.push({ id: 'c6u', name: 'Unit Client', approvalMode: 'professional_default' });
      db2.videos.push({ id: 'v6u', clientId: 'c6u', title: 'Unit video', status: 'published', publishedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), postLinks: { instagram: 'https://instagram.com/p/MEDIA123' } });
      const evs = comments.normalizeMetaEvents({ object: 'instagram', entry: [{ id: '1', time: Math.floor(Date.now() / 1000), changes: [
        { field: 'comments', value: { id: 'cm1', text: 'How much does it cost?', from: { username: 'buyer1', id: 'u1' }, media: { id: 'MEDIA123' } } },
        { field: 'comments', value: { id: 'cm2', text: 'Love this reset routine, trying it tomorrow!', from: { username: 'fan2', id: 'u2' }, media: { id: 'MEDIA123' } } },
        { field: 'comments', value: { id: 'cm3', text: '   ', from: { username: 'ghost', id: 'u3' }, media: { id: 'MEDIA123' } } },
      ] }] });
      assert.strictEqual(evs.length, 3);
      const intake = processMetaEvents(db2, evs);
      assert.deepStrictEqual(intake.results.map((r) => r.status), ['keyword_draft', 'ai_queued', 'ignored']);
      const kwReply = db2.replies.find((r) => r.commentEventId === 'comment:cm1');
      assert.ok(kwReply, 'keyword comment must produce a reply draft');
      assert.strictEqual(kwReply.status, 'draft', 'keyword reply is a DRAFT — nothing auto-posts');
      assert.strictEqual(kwReply.layer, 'keyword');
      assert.strictEqual(kwReply.withinFirstHour, true, 'a comment 5 minutes after publish is inside the first hour');
      assert.ok(kwReply.text.includes('DM'), 'keyword reply must route to DM');
      const aiJob = db2.aiJobs.find((j) => j.type === 'draft_reply');
      assert.ok(aiJob, 'a non-keyword comment must enqueue an AI draft job');
      assert.strictEqual(aiJob.status, 'queued');
      assert.strictEqual(db2.replies.filter((r) => r.commentEventId === 'comment:cm2').length, 0, 'the AI layer must not store a reply before the model drafts one');
      const dupIntake = processMetaEvents(db2, evs.slice(0, 1));
      assert.strictEqual(dupIntake.results[0].status, 'duplicate', 'a retried webhook delivery must dedupe by message id');
      assert.strictEqual(db2.webhookEvents.length, 3, 'the duplicate must not create a second event');
      console.log('Two-layer intake (keyword draft + AI job + ignored + dedupe) OK');
    }

    // ---- Wave 2D HTTP server (port 3465) ----
    const port6 = 3465;
    const child6 = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port6), DATA_FILE: '/tmp/vp-2d-test-data.json', BCB_AI_TOKEN: 'test-ai-token', SOPHIA_SERVICE_TOKEN: 'test-service-token', META_APP_SECRET: 'test-meta-secret', META_VERIFY_TOKEN: 'test-meta-verify', BCB_WORKER_TOKEN: 'test-worker-token' }, stdio: 'pipe' });
    const base6 = `http://127.0.0.1:${port6}`;
    try {
      for (let i = 0; i < 50; i++) { try { const r = await fetch(base6 + '/api/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
      const api6 = async (path, method, body, token, extraHeaders) => {
        const r = await fetch(base6 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(extraHeaders || {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`); return j;
      };
      const api6err = async (path, method, body, token, extraHeaders) => {
        const r = await fetch(base6 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(extraHeaders || {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); return { status: r.status, body: j };
      };
      // Fail-closed without the secrets (main child, port 3456, has
      // none of META_APP_SECRET / META_VERIFY_TOKEN / BCB_WORKER_TOKEN).
      const noSecretHook = await fetch(base + '/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=CH', { method: 'GET' });
      assert.strictEqual(noSecretHook.status, 503, 'webhook handshake must fail closed 503 without META_VERIFY_TOKEN');
      const noSecretPost = await fetch(base + '/webhooks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object: 'instagram', entry: [] }) });
      assert.strictEqual(noSecretPost.status, 503, 'webhook POST must fail closed 503 without META_APP_SECRET');
      const noWorker = await fetch(base + '/api/worker/publish/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.strictEqual(noWorker.status, 503, 'worker publish run must fail closed 503 without BCB_WORKER_TOKEN');
      console.log('Worker + webhook fail-closed without secrets OK');

      await api6('/api/setup', 'POST', { password: 'pw66' });
      const login6 = await api6('/api/login', 'POST', { password: 'pw66' });
      const ct6 = login6.token;
      const c6 = await api6('/api/coordinator/clients', 'POST', { name: 'Wave2D Client', email: 'w2d@example.com', approvalMode: 'professional_default' }, ct6);
      const c7 = await api6('/api/coordinator/clients', 'POST', { name: 'Wave2D Approval Client', email: 'w2d2@example.com', approvalMode: 'per_post_approval' }, ct6);
      const red6 = await api6('/api/redeem', 'POST', { code: c6.code.code });
      const red7 = await api6('/api/redeem', 'POST', { code: c7.code.code });
      const v6 = await api6('/api/client/videos', 'POST', { title: 'Publish test video', topic: 't', promise: 'p' }, red6.token);
      const v7 = await api6('/api/client/videos', 'POST', { title: 'Approval test video', topic: 't', promise: 'p' }, red7.token);

      // Webhook: handshake, bad signature, good signature, duplicate.
      const hsBad = await fetch(base6 + '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE', { method: 'GET' });
      assert.strictEqual(hsBad.status, 403, 'wrong verify token must be refused');
      const hsOk = await fetch(base6 + '/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-meta-verify&hub.challenge=CHALLENGE', { method: 'GET' });
      assert.strictEqual(hsOk.status, 200);
      assert.strictEqual(await hsOk.text(), 'CHALLENGE', 'handshake must echo the challenge');
      const hookBody = JSON.stringify({ object: 'instagram', entry: [{ id: '1', time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id: 'cmX', text: 'How much?', from: { username: 'buyer', id: 'u9' }, media: { id: 'NOPE' } } }] }] });
      const crypto6 = require('crypto');
      const goodSig = 'sha256=' + crypto6.createHmac('sha256', 'test-meta-secret').update(hookBody).digest('hex');
      const badSig = await fetch(base6 + '/webhooks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' }, body: hookBody });
      assert.strictEqual(badSig.status, 401, 'bad webhook signature must be rejected');
      const tHook = Date.now();
      const goodHook = await fetch(base6 + '/webhooks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': goodSig }, body: hookBody });
      assert.strictEqual(goodHook.status, 200, 'good signature must be accepted fast');
      assert.ok(Date.now() - tHook < 5000, 'webhook must return 200 fast, not after processing');
      const goodJson = await goodHook.json();
      assert.strictEqual(goodJson.results[0].status, 'needs_video', 'a comment on an unknown media id is kept as needs_video, never drafted blind');
      const dupHook = await fetch(base6 + '/webhooks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': goodSig }, body: hookBody });
      const dupJson = await dupHook.json();
      assert.strictEqual(dupJson.results[0].status, 'duplicate', 'Meta retries must dedupe by message id');
      console.log('Webhook (handshake, bad/good signature, 200 fast, needs_video, dedupe) OK');

      // Publish route, zero adapters: every platform refuses honestly.
      const mcpPub = await api6('/api/ai/mcp/bcb.publish', 'POST', { video_id: v6.video.id, platforms: ['tiktok', 'youtube', 'instagram', 'facebook'] }, null, { 'X-Sophia-Token': 'test-service-token' });
      assert.strictEqual(mcpPub.status, 'queued');
      assert.strictEqual(mcpPub.platforms.tiktok.status, 'scheduled');
      assert.ok(/^[0-9a-f]{32}$/.test(mcpPub.platforms.tiktok.idempotencyKey), 'MCP publish must carry an idempotency key');
      const pub = await api6(`/api/videos/${v6.video.id}/publish`, 'POST', { platforms: ['tiktok', 'youtube', 'instagram', 'facebook'] }, ct6);
      assert.strictEqual(pub.outcomes.length, 4, 'all four platforms must be attempted');
      for (const o of pub.outcomes) {
        assert.ok(['error', 'failed'].includes(o.outcome), `${o.platform} must refuse honestly with zero adapters, got: ${o.outcome}`);
      }
      assert.deepStrictEqual(pub.video.postLinks, {}, 'postLinks must stay empty — nothing is marked published');
      for (const pl of ['tiktok', 'youtube', 'instagram', 'facebook']) {
        const r = pub.publish.platforms.find((x) => x.platform === pl);
        assert.ok(r, `${pl} must have a publish record`);
        assert.ok(r.errorText && r.errorText.length > 10, `${pl} record must carry a plain-language reason, got: ${r.errorText}`);
      }
      assert.strictEqual(pub.publish.hasFailure, true);
      assert.strictEqual(pub.publish.partialFailure, false, '0 sent + 4 failed is not a partial failure');
      const keyBefore = pub.video.publish.tiktok.idempotencyKey;
      const retry = await api6(`/api/videos/${v6.video.id}/publish/tiktok/retry`, 'POST', {}, ct6);
      assert.strictEqual(retry.publish.platforms.find((x) => x.platform === 'tiktok').status, 'scheduled');
      assert.notStrictEqual(retry.video.publish.tiktok.idempotencyKey, keyBefore, 'a retry gets a fresh idempotency key');
      // per_post_approval: records land in needs_approval, no attempt.
      const pub7 = await api6(`/api/videos/${v7.video.id}/publish`, 'POST', { platforms: ['tiktok', 'youtube'] }, ct6);
      assert.deepStrictEqual(pub7.outcomes, [], 'needs_approval records must not be attempted');
      assert.strictEqual(pub7.publish.platforms.find((x) => x.platform === 'tiktok').status, 'needs_approval');
      const appr = await api6(`/api/videos/${v7.video.id}/publish/tiktok/approve`, 'POST', {}, ct6);
      assert.strictEqual(appr.publish.platforms.find((x) => x.platform === 'tiktok').status, 'scheduled');
      const badPlat = await api6err(`/api/videos/${v6.video.id}/publish`, 'POST', { platforms: ['myspace'] }, ct6);
      assert.strictEqual(badPlat.status, 400, 'an unknown platform must be refused');
      console.log('Publish route (zero adapters refuse honestly, retry, needs_approval) OK');

      // Worker endpoints: auth, then the run picks up the due retry.
      const wNoAuth = await api6err('/api/worker/publish/run', 'POST', {}, null);
      assert.strictEqual(wNoAuth.status, 401, 'worker run without a token must be refused');
      const wWrong = await api6err('/api/worker/publish/run', 'POST', {}, null, { 'X-Worker-Token': 'wrong' });
      assert.strictEqual(wWrong.status, 401, 'worker run with a wrong token must be refused');
      const wRun = await api6('/api/worker/publish/run', 'POST', {}, null, { 'X-Worker-Token': 'test-worker-token' });
      assert.strictEqual(wRun.attempted, 2, 'the worker must pick up both due records (v6 retry + v7 approved TikTok), got: ' + JSON.stringify(wRun));
      assert.strictEqual(wRun.failed, 2);
      assert.deepStrictEqual(wRun.outcomes.map((o) => o.videoId).sort(), [v6.video.id, v7.video.id].sort(), 'both videos must be attempted');
      const wRun2 = await api6('/api/worker/publish/run', 'POST', {}, null, { Authorization: 'Bearer test-worker-token' });
      assert.strictEqual(wRun2.attempted, 0, 'a second run must find nothing due');
      const sweep = await api6('/api/worker/tokens/sweep', 'POST', {}, null, { 'X-Worker-Token': 'test-worker-token' });
      assert.strictEqual(sweep.ok, true);
      assert.strictEqual(sweep.checked, 0, 'no tokens connected yet — sweep checks zero');
      const tokList = await api6('/api/coordinator/tokens', 'GET', null, ct6);
      assert.deepStrictEqual(tokList.tokens, [], 'token overview is empty until an account connects');
      console.log('Worker endpoints (auth, publish run, token sweep) OK');

      // Desk aggregate + page: publish queue, tokens, intake present.
      const desk6 = await api6('/api/coordinator/desk', 'GET', null, ct6);
      assert.ok(Array.isArray(desk6.publishQueue) && desk6.publishQueue.length >= 2, 'desk must list the publish queue');
      assert.ok(Array.isArray(desk6.tokens), 'desk must list token health');
      assert.ok(Array.isArray(desk6.webhookEvents) && desk6.webhookEvents.length === 1, 'desk must list the one webhook event');
      assert.strictEqual(desk6.webhookEvents[0].status, 'needs_video');
      assert.ok(desk6.counts.publishFailed >= 4, 'desk counts must include failed publishes, got: ' + desk6.counts.publishFailed);
      assert.strictEqual(desk6.publish.adaptersEnabled.tiktok, false, 'desk must report the TikTok adapter disabled');
      assert.ok(desk6.videos[0].firstHour, 'desk videos must carry the first-hour timer');
      const deskPage6 = await fetch(base6 + '/desk');
      const deskHtml6 = await deskPage6.text();
      for (const id of ['sec-publish', 'sec-tokens', 'sec-intake', 'publishList', 'tokenList', 'intakeList']) {
        assert.ok(deskHtml6.includes(`id="${id}"`), `desk page must contain #${id}`);
      }
      console.log('Desk aggregate + /desk page (publish, tokens, intake) OK');
    } finally { child6.kill(); try { fs.unlinkSync('/tmp/vp-2d-test-data.json'); } catch {} }

    // ---- Portable tokens, step 3 — HTTP: disabled by default, then
    // issue -> pop once -> refresh rotates -> reuse revokes family.
    const port7 = 3465;
    const child7 = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port7), DATA_FILE: '/tmp/vp-pt-test-data.json', BCB_PORTABLE_TOKENS_ENABLED: '1' }, stdio: 'pipe' });
    try {
      const base7 = `http://127.0.0.1:${port7}`;
      for (let i = 0; i < 50; i++) { try { const r = await fetch(base7 + '/api/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
      const api7 = async (path, method, body, token) => {
        const r = await fetch(base7 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`); return j;
      };
      const api7err = async (path, method, body, token) => {
        const r = await fetch(base7 + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); return { status: r.status, body: j };
      };
      await api7('/api/setup', 'POST', { password: 'pw-pt' });
      const login7 = await api7('/api/login', 'POST', { password: 'pw-pt' });
      const ct7 = login7.token;
      const cpt = await api7('/api/coordinator/clients', 'POST', { name: 'Portable Token Client', email: 'pt@example.com' }, ct7);
      // Bad scope / unknown client are refused before anything is issued.
      const badScope = await api7err('/api/coordinator/portable-tokens', 'POST', { clientId: cpt.client.id, scopes: ['bcb.chat', 'tokens:issue'] }, ct7);
      assert.strictEqual(badScope.status, 400, 'a tokens:issue scope must be refused 400');
      const noClient = await api7err('/api/coordinator/portable-tokens', 'POST', { clientId: 'no-such-client', scopes: ['bcb.chat'] }, ct7);
      assert.strictEqual(noClient.status, 404, 'issuing for an unknown client must be 404');
      // Issue: the response carries metadata + a handoff id — never a plaintext token.
      const issued = await api7('/api/coordinator/portable-tokens', 'POST', { clientId: cpt.client.id, name: 'Render wrapper token', scopes: ['bcb.chat', 'bcb.batch'] }, ct7);
      assert.strictEqual(issued.token.status, 'active');
      assert.deepStrictEqual(issued.token.scopes, ['bcb.batch', 'bcb.chat'], 'scopes must be stored sorted');
      assert.ok(issued.handoffId && issued.handoffExpiresInSeconds === 900, 'issue must return a 15-minute handoff id');
      assert.ok(!JSON.stringify(issued).includes('accessHash') && !JSON.stringify(issued).includes('refreshHash') && !('accessToken' in issued) && !('refreshToken' in issued), 'the issue response must never contain a hash or a token value — only metadata + the handoff id (the identifying prefix is shown by design)');
      // Pop once: values + Render env block. Pop twice: gone (410).
      const popped = await api7(`/api/coordinator/portable-tokens/handoff/${issued.handoffId}/pop`, 'POST', {}, ct7);
      assert.ok(popped.accessToken.startsWith('bcb_live_') && popped.refreshToken.startsWith('bcb_refresh_'), 'the pop must return the pair once');
      assert.ok(popped.renderEnv.includes('SOPHIA_WRAPPER_TOKEN=' + popped.accessToken) && popped.renderEnv.includes('SOPHIA_WRAPPER_REFRESH_TOKEN=' + popped.refreshToken), 'the pop must include the Render env block');
      const poppedAgain = await api7err(`/api/coordinator/portable-tokens/handoff/${issued.handoffId}/pop`, 'POST', {}, ct7);
      assert.strictEqual(poppedAgain.status, 410, 'a second pop must be 410 — the handoff is deleted at the source');
      // List + status show metadata only, no hash, no plaintext.
      const listed7 = await api7('/api/coordinator/portable-tokens', 'GET', null, ct7);
      assert.strictEqual(listed7.tokens.length, 1);
      assert.ok(!JSON.stringify(listed7).includes('accessHash') && !JSON.stringify(listed7).includes(popped.accessToken) && !JSON.stringify(listed7).includes(popped.refreshToken), 'the list must show metadata only — no hash, no full token value (the identifying prefix is shown by design)');
      const status7 = await api7('/api/coordinator/ai/status', 'GET', null, ct7);
      assert.strictEqual(status7.portableTokens.enabled, true);
      assert.strictEqual(status7.portableTokens.count, 1); assert.strictEqual(status7.portableTokens.active, 1);
      // Refresh rotates: new pair, old refresh replay revokes the family.
      const rotated = await api7('/api/tokens/refresh', 'POST', { refreshToken: popped.refreshToken });
      assert.notStrictEqual(rotated.accessToken, popped.accessToken, 'rotation must issue a new access token');
      assert.notStrictEqual(rotated.refreshToken, popped.refreshToken, 'rotation must issue a new refresh token');
      assert.strictEqual(rotated.expiresInSeconds, 3600, 'the new access token must live 3600 seconds');
      const replay7 = await api7err('/api/tokens/refresh', 'POST', { refreshToken: popped.refreshToken });
      assert.strictEqual(replay7.status, 401, 'replaying a used refresh token must be 401');
      assert.strictEqual(replay7.body.error, 'api_key_revoked'); assert.strictEqual(replay7.body.familyRevoked, true, 'the replay must report family revocation');
      const listedAfterReplay = await api7('/api/coordinator/portable-tokens', 'GET', null, ct7);
      assert.strictEqual(listedAfterReplay.tokens[0].status, 'revoked', 'the family must be revoked after a refresh replay');
      // A token in a query string is refused, never read.
      const queryRefused = await api7err('/api/tokens/refresh?refreshToken=' + encodeURIComponent(rotated.refreshToken), 'POST', { refreshToken: rotated.refreshToken });
      assert.strictEqual(queryRefused.status, 400, 'a token in a query string must be refused 400');
      // Second token: revoke by route, then its refresh is dead too.
      const issued2 = await api7('/api/coordinator/portable-tokens', 'POST', { clientId: cpt.client.id, scopes: ['bcb.batch'] }, ct7);
      const popped2 = await api7(`/api/coordinator/portable-tokens/handoff/${issued2.handoffId}/pop`, 'POST', {}, ct7);
      const revoked2 = await api7(`/api/coordinator/portable-tokens/${issued2.token.id}/revoke`, 'POST', { reason: 'test revoke' }, ct7);
      assert.strictEqual(revoked2.token.status, 'revoked'); assert.strictEqual(revoked2.token.revokedReason, 'test revoke');
      const refreshRevoked = await api7err('/api/tokens/refresh', 'POST', { refreshToken: popped2.refreshToken });
      assert.strictEqual(refreshRevoked.status, 401); assert.strictEqual(refreshRevoked.body.error, 'api_key_revoked');
      const revokeUnknown = await api7err('/api/coordinator/portable-tokens/pt_nope/revoke', 'POST', {}, ct7);
      assert.strictEqual(revokeUnknown.status, 404, 'revoking an unknown token must be 404');
      const noAuthList = await api7err('/api/coordinator/portable-tokens', 'GET', null, null);
      assert.strictEqual(noAuthList.status, 401, 'the token list must require coordinator login');
      console.log('Portable tokens (HTTP: issue -> pop once -> refresh rotates -> replay revokes family -> revoke) OK');
    } finally { child7.kill(); try { fs.unlinkSync('/tmp/vp-pt-test-data.json'); } catch {} }
    // Disabled by default: the same routes fail closed 503 with no env flag.
    const port7b = 3466;
    const child7b = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port7b), DATA_FILE: '/tmp/vp-pt-off-test-data.json' }, stdio: 'pipe' });
    try {
      const base7b = `http://127.0.0.1:${port7b}`;
      for (let i = 0; i < 50; i++) { try { const r = await fetch(base7b + '/api/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
      const api7berr = async (path, method, body, token) => {
        const r = await fetch(base7b + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); return { status: r.status, body: j };
      };
      await api7berr('/api/setup', 'POST', { password: 'pw-pt-off' });
      const login7b = await fetch(base7b + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-pt-off' }) });
      const ct7b = (await login7b.json()).token;
      assert.strictEqual((await api7berr('/api/coordinator/portable-tokens', 'POST', { clientId: 'x', scopes: ['bcb.chat'] }, ct7b)).status, 503, 'issue must fail closed 503 when issuance is not enabled');
      assert.strictEqual((await api7berr('/api/coordinator/portable-tokens', 'GET', null, ct7b)).status, 503, 'list must fail closed 503 when issuance is not enabled');
      assert.strictEqual((await api7berr('/api/tokens/refresh', 'POST', { refreshToken: 'bcb_refresh_x' })).status, 503, 'refresh must fail closed 503 when issuance is not enabled');
      console.log('Portable tokens (disabled by default: 503 on issue/list/refresh) OK');
    } finally { child7b.kill(); try { fs.unlinkSync('/tmp/vp-pt-off-test-data.json'); } catch {} }

    // Concurrent writes, end to end: two app processes sharing one JSON
    // file; a schedule write and a block on the same video at the same
    // time must BOTH land (the old whole-blob overwrite lost one).
    const concFile = '/tmp/vp-2c-concurrent.json';
    try { fs.unlinkSync(concFile); } catch {}
    const portA = 3463, portB = 3464;
    const childA = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(portA), DATA_FILE: concFile, BCB_AI_TOKEN: 'test-ai-token', SOPHIA_SERVICE_TOKEN: 'test-service-token' }, stdio: 'pipe' });
    let childB = null;
    try {
      const baseA = `http://127.0.0.1:${portA}`, baseB = `http://127.0.0.1:${portB}`;
      for (let i = 0; i < 50; i++) { try { const r = await fetch(baseA + '/api/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
      const apiA = async (path, method, body, token) => {
        const r = await fetch(baseA + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`); return j;
      };
      const apiB = async (path, method, body, token) => {
        const r = await fetch(baseB + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`); return j;
      };
      await apiA('/api/setup', 'POST', { password: 'pw-conc' });
      const loginA = await apiA('/api/login', 'POST', { password: 'pw-conc' });
      const ctA = loginA.token;
      const cc = await apiA('/api/coordinator/clients', 'POST', { name: 'Conc Client', email: 'conc@example.com' }, ctA);
      const redC = await apiA('/api/redeem', 'POST', { code: cc.code.code });
      const vc = await apiA('/api/client/videos', 'POST', { title: 'Conc video', topic: 't', promise: 'p' }, redC.token);
      // Start B only now: the JSON-file path caches the db in-process, so
      // a process started before the coordinator/video existed would
      // never see them (pre-existing read-freshness limit of the JSON
      // fallback — the Postgres path re-reads on every getDb). B loads
      // the file fresh at boot, so it sees the coordinator + video.
      childB = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(portB), DATA_FILE: concFile, BCB_AI_TOKEN: 'test-ai-token', SOPHIA_SERVICE_TOKEN: 'test-service-token' }, stdio: 'pipe' });
      for (let i = 0; i < 50; i++) { try { const r = await fetch(baseB + '/api/health'); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
      const loginB = await apiB('/api/login', 'POST', { password: 'pw-conc' });
      const ctB = loginB.token;
      // Warm both processes' copies to the same revision, then fire both
      // writes at once: A schedules, B blocks.
      await apiA('/api/coordinator/desk', 'GET', null, ctA);
      await apiB('/api/coordinator/desk', 'GET', null, ctB);
      await Promise.all([
        apiA(`/api/videos/${vc.video.id}/schedule`, 'POST', { schedule: { youtube: '2026-11-20 12:00' } }, ctA),
        apiB(`/api/videos/${vc.video.id}/block`, 'POST', { reason: 'concurrent block', owner: 'coordinator' }, ctB),
      ]);
      // Second round, roles reversed, to catch ordering flukes.
      await apiA('/api/coordinator/desk', 'GET', null, ctA);
      await apiB(`/api/videos/${vc.video.id}/unblock`, 'POST', {}, ctB);
      await Promise.all([
        apiB(`/api/videos/${vc.video.id}/schedule`, 'POST', { schedule: { youtube: '2026-11-21 12:00', tiktok: '2026-11-21 17:00' } }, ctB),
        apiA(`/api/videos/${vc.video.id}/stage`, 'POST', { status: 'step2' }, ctA),
      ]);
      // Ground truth is the shared file (each process caches reads).
      const storedConc = JSON.parse(fs.readFileSync(concFile, 'utf8'));
      const concVideo = storedConc.videos.find((v) => v.id === vc.video.id);
      assert.ok(concVideo, 'concurrent video must survive');
      assert.strictEqual(concVideo.schedule.youtube, '2026-11-21 12:00', 'concurrent schedule write must land, got: ' + JSON.stringify(concVideo.schedule));
      assert.strictEqual(concVideo.schedule.tiktok, '2026-11-21 17:00', 'second schedule write must land');
      assert.strictEqual(concVideo.status, 'step2', 'concurrent stage write must land');
      assert.ok(concVideo.pausedMsTotal > 0, 'the block/unblock round must have accumulated paused time');
      assert.strictEqual(concVideo.pausedAt, null, 'video must end unblocked');
      console.log('Concurrent writes (two processes, one JSON file) OK: schedule + block + stage all landed, pausedMsTotal=' + concVideo.pausedMsTotal + 'ms');
    } finally { childA.kill(); if (childB) childB.kill(); try { fs.unlinkSync(concFile); } catch {} }
    console.log('ALL TESTS PASSED');
  } finally {
    child.kill();
  }
}
main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
