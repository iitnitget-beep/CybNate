'use strict';
/* Day 4 — Credential security and permissions: encrypted token/secret storage,
   key management, token refresh (incl. refused refresh revoking the session),
   least-privilege grants (canUse/requireUse), revocation, audit events without
   token values, and CORS/session protections on the HTTP API.
   OAuth token endpoints are stubbed; the HTTP API runs on a local port. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../server/src/store');
const OAuth = require('../server/src/oauth');
const App = require('../server/src/app');

const realFetch = global.fetch;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

global.fetch = async (url, o) => {
  const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
  if (String(url).endsWith('/token')) {
    const f = Object.fromEntries(new URLSearchParams(String((o && o.body) || '')));
    if (f.grant_type === 'authorization_code' && f.code === 'good-code' && f.code_verifier) return reply(200, { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600, scope: 'openid email' });
    if (f.grant_type === 'refresh_token' && f.refresh_token === 'ref-1') return reply(200, { access_token: 'tok-2', expires_in: 3600 });
    return reply(400, { error: 'invalid_grant' });
  }
  if (String(url).endsWith('/userinfo')) return reply(200, { email: 'asha@example.com' });
  if (String(url).endsWith('/revoke')) return reply(200, {});
  return reply(404, {});
};

(async () => {
  // ---------------------------------------------------------------- encrypted storage + key management
  const dir = tmp('cyb-cred-');
  assert.throws(() => Store.open(tmp('cyb-badkey-'), 'too-short'), /CYB_MASTER_KEY/, 'short env master key rejected');
  let store = Store.open(dir);
  assert.strictEqual(fs.statSync(path.join(dir, 'master.key')).mode & 0o077, 0, 'master.key file is owner-only (0600)');

  const regA = store.register('Asha', 'phone-a'), regB = store.register('Bala', 'phone-b');
  const A = { id: regA.id }, B = { id: regB.id };
  store.secretPut(A.id, 'MY_KEY', 'super-secret-value-123');
  store.oauthPut(A.id, 'google', { access: 'tok-secret-xyz', refresh: 'ref-secret-xyz', exp: 0, scopes: ['openid'], who: '', at: Date.now() });
  assert.strictEqual(store.secretGet(A.id, 'MY_KEY'), 'super-secret-value-123', 'secret round-trips for its owner');
  assert.strictEqual(store.secretGet(B.id, 'MY_KEY'), null, 'another user cannot read the secret');
  assert.strictEqual(store.oauthGet(B.id, 'google'), null, 'another user cannot read the OAuth session');

  const dbBytes = Buffer.concat(['cybnate.db', 'cybnate.db-wal'].map((f) => { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0); }));
  assert.ok(!dbBytes.includes('super-secret-value-123'), 'secret value is not plaintext in the database file');
  assert.ok(!dbBytes.includes('tok-secret-xyz') && !dbBytes.includes('ref-secret-xyz'), 'OAuth tokens are not plaintext in the database file');

  store.close();
  const wrongKey = Store.open(dir, '0'.repeat(64));
  assert.throws(() => wrongKey.secretGet(A.id, 'MY_KEY'), 'a different master key cannot unseal secrets');
  wrongKey.close();
  store = Store.open(dir); // back to the file key

  // ---------------------------------------------------------------- grants, refresh, revocation, audit
  const oauth = OAuth.create(store, {
    publicUrl: 'https://example.test',
    providers: {
      google: {
        name: 'Google', authUrl: 'https://up.test/auth', tokenUrl: 'https://up.test/token', revokeUrl: 'https://up.test/revoke',
        clientId: 'g-client', clientSecret: 'g-secret', baseScopes: ['openid', 'email'], scopeSep: ' ',
        allowedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
        extra: {}, who: { url: 'https://up.test/userinfo', field: 'email' }, secrets: ['GOOGLE_ACCESS_TOKEN'],
      },
    },
  });

  // unauthorized before connect: denied, and the denial is audited
  store.oauthDel(A.id, 'google'); // clear the storage-phase fixture above
  assert.deepStrictEqual(oauth.canUse(A, 'google', ['openid']), { ok: false, reason: 'not_connected', missing: ['openid'] });
  assert.throws(() => oauth.requireUse(A, 'google', ['openid']), (e) => e.status === 403 && e.reason === 'not_connected', 'tool use denied before connect');
  assert.strictEqual(oauth.canUse(A, 'nope', []).reason, 'unknown_provider');

  const s1 = oauth.start(A, 'google', []);
  const cb = await oauth.callback({ state: s1.state, code: 'good-code' });
  assert.strictEqual(cb.ok, true, cb.message);
  assert.strictEqual(oauth.requireUse(A, 'google', ['openid', 'email']), true, 'granted scopes may be used');
  assert.throws(() => oauth.requireUse(A, 'google', ['https://www.googleapis.com/auth/gmail.readonly']), (e) => e.status === 403 && e.reason === 'missing_scopes' && e.missing.length === 1, 'ungranted scope denied (least privilege)');
  assert.strictEqual(oauth.canUse(B, 'google', ['openid']).ok, false, 'grants are per user');

  // refresh: expired access token is renewed and stored
  store.oauthPut(A.id, 'google', { access: 'old-tok', refresh: 'ref-1', exp: Date.now() - 1000, scopes: ['openid', 'email'], who: '', at: Date.now() });
  assert.strictEqual(await oauth.accessToken(A, 'google'), 'tok-2', 'expired token refreshed');
  assert.strictEqual(store.oauthGet(A.id, 'google').access, 'tok-2', 'refreshed token stored');

  // refused refresh revokes the session: it cannot be used again
  store.oauthPut(A.id, 'google', { access: 'old-tok', refresh: 'ref-bad', exp: Date.now() - 1000, scopes: ['openid', 'email'], who: '', at: Date.now() });
  await assert.rejects(() => oauth.accessToken(A, 'google'), (e) => e.status === 401, 'refused refresh surfaces as sign-in expired');
  assert.strictEqual(store.oauthGet(A.id, 'google'), null, 'refused refresh deletes the session');
  assert.strictEqual(oauth.canUse(A, 'google', ['openid']).ok, false, 'revoked-by-refresh connection cannot be used');

  // reconnect, then disconnect revokes use immediately
  const s2 = oauth.start(A, 'google', []);
  assert.strictEqual((await oauth.callback({ state: s2.state, code: 'good-code' })).ok, true);
  assert.strictEqual(await oauth.disconnect(A, 'google'), true);
  assert.strictEqual(await oauth.accessToken(A, 'google'), null, 'no token after disconnect');
  assert.throws(() => oauth.requireUse(A, 'google', ['openid']), (e) => e.status === 403, 'revoked connection cannot be used');

  const events = store.auditList(A.id, 50);
  const names = events.map((e) => e.event);
  for (const ev of ['oauth.connected', 'oauth.refreshed', 'oauth.refresh_refused', 'oauth.disconnected', 'credential.denied']) assert.ok(names.includes(ev), 'audit event recorded: ' + ev);
  const auditText = JSON.stringify(events);
  for (const secret of ['tok-1', 'tok-2', 'ref-1', 'ref-bad', 'super-secret-value-123', 'g-secret']) assert.ok(!auditText.includes(secret), 'audit trail never contains credential values');
  assert.strictEqual(store.auditList(B.id, 50).length, 0, 'audit events are per user');
  store.close();

  // ---------------------------------------------------------------- HTTP API: CORS, session, audit endpoint
  global.fetch = realFetch;
  const dir3 = tmp('cyb-cred-http-');
  const app = App.create({ dataDir: dir3, accessKey: 'test-access-key-123456', allowShared: true, allowPrivate: true, publicUrl: 'http://127.0.0.1', lspServers: {} });
  const BASE = await listen(app.server);
  const call = async (method, p, body, token) => {
    const r = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, headers: r.headers, text, json };
  };
  try {
    const health = await call('GET', '/v1/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.headers.get('referrer-policy'), 'no-referrer', 'Referrer-Policy set');
    assert.strictEqual(health.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options set');
    assert.strictEqual(health.headers.get('access-control-allow-origin'), '*', 'CORS origin present (Bearer-only auth)');

    assert.strictEqual((await call('GET', '/v1/me')).status, 401, 'unauthorized request denied');
    assert.strictEqual((await call('POST', '/v1/auth/register', { accessKey: 'wrong-key-1234567890' })).status, 403, 'wrong access key denied');
    /* The register route also creates the per-user workspace (chown to a per-user uid), which this
       container cannot do — the same pre-existing environment failure documented for
       server/test/server.test.js on Day 3. Create the device token through the store instead;
       every route below still goes through real HTTP auth. */
    const token = app.store.register('Asha', 'phone').token;
    assert.strictEqual((await call('GET', '/v1/me', undefined, token)).status, 200, 'device token authenticates');

    assert.strictEqual((await call('PUT', '/v1/secrets/MY_KEY', { value: 'app-secret-999' }, token)).status, 200);
    const listed = await call('GET', '/v1/secrets', undefined, token);
    assert.ok(listed.text.includes('MY_KEY') && !listed.text.includes('app-secret-999'), 'secrets listed by name only');
    assert.strictEqual((await call('DELETE', '/v1/secrets/MY_KEY', undefined, token)).status, 200);

    const auditRes = await call('GET', '/v1/audit?limit=50', undefined, token);
    assert.strictEqual(auditRes.status, 200, auditRes.text);
    const httpEvents = auditRes.json.events.map((e) => e.event);
    assert.ok(httpEvents.includes('secret.put') && httpEvents.includes('secret.deleted'), 'HTTP audit events recorded');
    assert.ok(!auditRes.text.includes('app-secret-999') && !auditRes.text.includes(token), 'audit endpoint leaks no secret or token values');
    assert.strictEqual((await call('GET', '/v1/audit')).status, 401, 'audit endpoint requires sign-in');

    assert.strictEqual((await call('POST', '/v1/auth/logout', {}, token)).status, 200);
    assert.strictEqual((await call('GET', '/v1/me', undefined, token)).status, 401, 'revoked device token cannot be used');
  } finally { await app.close(); }

  console.log('CREDENTIAL SECURITY TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
