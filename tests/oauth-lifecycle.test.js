'use strict';
/* Day 3 — OAuth connection lifecycle: per-user isolation, state/PKCE validation,
   one-use callback, disconnect revocation, explicit re-consent for added scopes,
   and no client secret in client assets. Uses a fake store + stubbed fetch; no network. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const OAuth = require('../server/src/oauth');

const calls = [];
global.fetch = async (url, o) => {
  calls.push({ url: String(url), body: (o && o.body) || '' });
  const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
  if (String(url).endsWith('/token')) {
    const f = Object.fromEntries(new URLSearchParams(String(o.body || '')));
    if (f.grant_type === 'authorization_code' && f.code === 'good-code' && f.code_verifier) return reply(200, { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600, scope: 'openid email' });
    return reply(400, { error: 'invalid_grant' });
  }
  if (String(url).endsWith('/userinfo')) return reply(200, { email: 'asha@example.com' });
  if (String(url).endsWith('/revoke')) return reply(200, {});
  return reply(404, {});
};

function fakeStore() {
  const oauth = new Map(), cache = new Map();
  return {
    oauthGet: (u, p) => oauth.get(u + ':' + p) || null,
    oauthPut: (u, p, d) => oauth.set(u + ':' + p, JSON.parse(JSON.stringify(d))),
    oauthDel: (u, p) => oauth.delete(u + ':' + p),
    cacheGet: (k) => { const v = cache.get(k); return v && v.exp > Date.now() ? v.value : null; },
    cachePut: (k, v, ttl) => cache.set(k, { value: v, exp: Date.now() + ttl }),
    _cache: cache,
  };
}
const store = fakeStore();
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
const A = { id: 'user-a' }, B = { id: 'user-b' };

(async () => {
  // unknown scope rejected against the allowlist
  assert.throws(() => oauth.start(A, 'google', ['https://evil.test/admin']), (e) => e.status === 400, 'unknown scope rejected');

  // state mismatch: no token exchange happens
  const before = calls.length;
  let r = await oauth.callback({ state: 'made-up', code: 'good-code' });
  assert.strictEqual(r.ok, false, 'made-up state refused');
  assert.strictEqual(calls.length, before, 'no token exchange on bad state');

  // PKCE verifier required: tamper the stored state, callback must refuse before exchange
  const s1 = oauth.start(A, 'google', []);
  const entry = store._cache.get('oauth-state:' + s1.state);
  entry.value = Object.assign({}, entry.value, { verifier: '' });
  const before2 = calls.length;
  r = await oauth.callback({ state: s1.state, code: 'good-code' });
  assert.strictEqual(r.ok, false, 'missing PKCE verifier refused');
  assert.strictEqual(calls.length, before2, 'no token exchange without verifier');

  // happy path + one-use callback (replay refused)
  const s2 = oauth.start(A, 'google', []);
  assert.ok(new URL(s2.url).searchParams.get('code_challenge'), 'PKCE challenge present');
  r = await oauth.callback({ state: s2.state, code: 'good-code' });
  assert.strictEqual(r.ok, true, r.message);
  r = await oauth.callback({ state: s2.state, code: 'good-code' });
  assert.strictEqual(r.ok, false, 'callback is one-use only');

  // per-user isolation + status
  assert.strictEqual(oauth.status(A, 'google').connected, true);
  assert.strictEqual(oauth.status(B, 'google').connected, false, 'user B is not connected');
  assert.strictEqual(await oauth.accessToken(B, 'google'), null, 'user B gets no token');
  assert.ok(!JSON.stringify(oauth.status(A, 'google')).includes('tok-1'), 'status never leaks tokens');

  // added scope on an existing connection needs explicit re-consent
  assert.throws(() => oauth.start(A, 'google', ['https://www.googleapis.com/auth/gmail.readonly']), (e) => e.status === 409 && e.needsReconsent === true, 'added scope needs re-consent');
  const s3 = oauth.start(A, 'google', ['https://www.googleapis.com/auth/gmail.readonly'], { reconsent: true });
  assert.ok(new URL(s3.url).searchParams.get('scope').includes('gmail.readonly'), 're-consented scope is requested');
  assert.deepStrictEqual(s3.addedScopes, ['https://www.googleapis.com/auth/gmail.readonly']);

  // disconnect revokes (provider revoke called) and removes the session
  const before3 = calls.length;
  assert.strictEqual(await oauth.disconnect(A, 'google'), true);
  assert.ok(calls.slice(before3).some((c) => c.url.endsWith('/revoke')), 'provider revoke called on disconnect');
  assert.strictEqual(oauth.status(A, 'google').connected, false, 'disconnected after revoke');
  assert.strictEqual(await oauth.accessToken(A, 'google'), null, 'no token after disconnect');
  assert.strictEqual(await oauth.disconnect(A, 'google'), false, 'second disconnect is a no-op');

  // no client secret material in Android/web client assets (env-var names in help text are not secrets)
  const root = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(root).filter((x) => /\.(js|html)$/.test(x))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/client_secret\s*[:=]\s*['"][^'"]+['"]/.test(t), 'no client_secret literal in ' + f);
    assert.ok(!/clientSecret\s*[:=]\s*['"][^'"]+['"]/.test(t), 'no clientSecret literal in ' + f);
    assert.ok(!t.includes('g-secret'), 'test secret value absent from ' + f);
  }

  console.log('OAUTH LIFECYCLE TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
