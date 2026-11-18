#!/usr/bin/env node
// Issue portable BCB tokens — VPS-side CLI (step 3, code only).
//
// RUN THIS ON THE VPS ONLY (root), never from this VM: the token
// store lives next to the wrapper's tokens.json and the plaintext is
// printed ONCE to the operator's terminal for pasting into Render
// env vars. Tokens come from the Vultr server, NOT Telegram.
//
//   node scripts/issue-portable-token.cjs issue --client-id <id> --name <name> --scopes bcb.chat,bcb.batch,bcb.mcp:plan_video [--store /path]
//   node scripts/issue-portable-token.cjs list [--store /path]
//   node scripts/issue-portable-token.cjs revoke --id pt_... --reason "..." [--store /path]
//
// Store file (default /opt/sophia/foundation/portable-tokens.json):
//   { "tokens": [ <hash-only records, lib/portable-tokens.js shape> ],
//     "audit": [ { at, action, tokenId, actor, reason } ] }
// Plaintext is NEVER written to the store, a log, or any other file —
// only hashes. The store file is created mode 600.
// `list` prints metadata only (prefix, scopes, status, last used).
// This script makes no network call and never touches the gateway or
// the wrapper service. It does NOT activate anything: the wrapper
// still needs the verification-side change (docs/token-portability.md)
// before a token issued here can authenticate a live call.
'use strict';
const fs = require('fs');
const path = require('path');
const portable = require('../lib/portable-tokens');

const DEFAULT_STORE = '/opt/sophia/foundation/portable-tokens.json';

function usage(exitCode) {
  console.error([
    'Usage:',
    '  issue  --client-id <id> [--name <name>] --scopes <a,b,c> [--store <path>]',
    '  list   [--store <path>]',
    '  revoke --id <pt_...> [--reason <text>] [--store <path>]',
    '',
    'Allowed scopes: ' + portable.ALLOWED_SCOPES.join(', '),
    'Default store: ' + DEFAULT_STORE,
  ].join('\n'));
  process.exit(exitCode);
}
function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
function loadStore(storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tokens)) data.tokens = [];
    if (!Array.isArray(data.audit)) data.audit = [];
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return { tokens: [], audit: [] };
    throw e;
  }
}
function saveStore(storePath, data) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = storePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  try { fs.chmodSync(storePath, 0o600); } catch {}
}
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!['issue', 'list', 'revoke'].includes(cmd)) usage(2);
  const storePath = arg('--store', rest) || DEFAULT_STORE;
  const store = loadStore(storePath);
  if (cmd === 'list') {
    const list = portable.listPortableTokens(store.tokens);
    console.log(JSON.stringify({ tokens: list, count: list.length }, null, 2));
    return;
  }
  if (cmd === 'revoke') {
    const id = arg('--id', rest);
    if (!id) usage(2);
    const rec = portable.revokePortableToken(store.tokens, id, arg('--reason', rest) || 'revoked by operator on the VPS');
    if (!rec) { console.error('No portable token with id ' + id); process.exit(1); }
    store.audit.push({ at: new Date().toISOString(), action: 'revoke', tokenId: id, actor: 'vps-operator', reason: rec.revokedReason });
    saveStore(storePath, store);
    console.log(JSON.stringify({ revoked: portable.publicToken(rec) }, null, 2));
    return;
  }
  // issue
  const clientId = arg('--client-id', rest);
  const scopesArg = arg('--scopes', rest);
  if (!clientId || !scopesArg) usage(2);
  const scopes = scopesArg.split(',').map((s) => s.trim()).filter(Boolean);
  let minted;
  try {
    minted = portable.mintPortableToken({ clientId, name: arg('--name', rest), scopes });
  } catch (e) {
    console.error('Cannot issue: ' + e.message);
    process.exit(1);
  }
  store.tokens.push(minted.record);
  store.audit.push({ at: new Date().toISOString(), action: 'issue', tokenId: minted.record.id, actor: 'vps-operator', reason: `client ${clientId}, scopes ${minted.record.scopes.join(',')}` });
  saveStore(storePath, store);
  // Shown ONCE, on stdout only — never stored, never logged anywhere else.
  console.log(portable.formatRenderEnvVars(minted.issued));
  console.log('');
  console.log('Token id: ' + minted.record.id + ' (client ' + clientId + ', scopes ' + minted.record.scopes.join(', ') + ')');
  console.log('Access expires: ' + minted.record.accessExpiresAt + ' — refresh (one-time, rotating) expires: ' + minted.record.refreshExpiresAt);
  console.log('The values above will not be shown again. If lost, revoke this id and re-issue.');
}
main();
