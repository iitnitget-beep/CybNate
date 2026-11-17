// The backend against real processes: a real server on a local port, real bash/python/git in a temp folder,
// a fake identity provider + API for the sign-in flows, and a small fake language server.
// Run: node test/server.test.js
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const App = require('../src/app');
const Store = require('../src/store');
const Net = require('../src/net');

const jwt = (o) => 'h.' + Buffer.from(JSON.stringify(o)).toString('base64url') + '.s';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- fake outside world
  const up = { calls: [], codexPolls: 0, refreshes: 0, googleRefreshes: 0, tokenTtl: 3600, refuseRefresh: false };
  const upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); up.calls.push({ path: u.pathname, method: req.method, headers: req.headers, body });
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const f = Object.fromEntries(new URLSearchParams(body));
      if (u.pathname === '/google/token') {
        if (f.grant_type === 'authorization_code') return f.code === 'good-code' && f.client_secret === 'g-secret' && f.code_verifier ? json(200, { access_token: 'ya29.A1', refresh_token: 'g-refresh', expires_in: up.tokenTtl, scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' }) : json(400, { error: 'invalid_grant', error_description: 'Bad code' });
        if (up.refuseRefresh) return json(400, { error: 'invalid_grant', error_description: 'Token has been revoked' });
        up.googleRefreshes++; return f.refresh_token === 'g-refresh' && f.client_secret === 'g-secret' ? json(200, { access_token: 'ya29.A' + (up.googleRefreshes + 1), expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
      }
      if (u.pathname === '/google/userinfo') return json(200, { email: 'asha@gmail.com' });
      if (u.pathname === '/google/revoke') return json(200, {});
      if (u.pathname === '/api/echo') return json(200, { auth: req.headers.authorization || '', key: req.headers['x-key'] || '', q: u.search, body });
      if (u.pathname === '/api/redirect') { res.writeHead(302, { Location: 'http://localhost:' + upstream.address().port + '/api/echo' }); return res.end(); }
      if (u.pathname === '/api/accounts/deviceauth/usercode') return json(200, { device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '5' });
      if (u.pathname === '/api/accounts/deviceauth/token') { up.codexPolls++; return up.codexPolls < 3 ? json(403, {}) : json(200, { authorization_code: 'cx-code', code_challenge: 'c', code_verifier: 'cx-ver' }); }
      if (u.pathname === '/oauth/token') {
        if (f.grant_type === 'authorization_code') return f.code === 'cx-code' && f.code_verifier === 'cx-ver' ? json(200, { id_token: jwt({ email: 'asha@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc-9' } }), access_token: jwt({ exp: Math.floor(Date.now() / 1000) + up.tokenTtl, n: 1 }), refresh_token: 'cx-refresh' }) : json(400, { error: 'invalid_grant' });
        up.refreshes++; return json(200, { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 7200, n: 2 }), refresh_token: 'cx-refresh-2' });
      }
      if (u.pathname === '/codex/models') return req.headers['chatgpt-account-id'] === 'acc-9' ? json(200, { models: [{ slug: 'gpt-x', visibility: 'list', priority: 1 }] }) : json(401, { detail: 'no account' });
      if (u.pathname === '/codex/responses') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"response.output_text.delta","delta":"Hi "}\n\n'); return setTimeout(() => { res.write('data: {"type":"response.output_text.delta","delta":"there"}\n\n'); res.end(); }, 150); }
      json(404, {});
    });
  });
  const UP = await listen(upstream);

  // ---------------------------------------------------------------- the server under test
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyb-srv-'));
  const cfgOf = (publicUrl) => ({
    dataDir, accessKey: 'test-access-key-123456', publicUrl, corsOrigins: ['https://ui.cybnate.test'], allowShared: true, allowPrivate: true, maxParallel: 2, maxQueue: 4, beatMs: 100,
    lspServers: { fake: { cmd: [process.execPath, path.join(__dirname, 'fake-lsp.js')], ext: ['fk'], ids: { fk: 'fake' } }, absent: { cmd: ['cyb-no-such-language-server'], ext: ['zz'] } },
    oauthProviders: { google: { name: 'Google', authUrl: UP + '/google/auth', tokenUrl: UP + '/google/token', revokeUrl: UP + '/google/revoke', clientId: 'g-client', clientSecret: 'g-secret', baseScopes: ['openid', 'email'], scopeSep: ' ', extra: { access_type: 'offline' }, who: { url: UP + '/google/userinfo', field: 'email' }, secrets: ['GOOGLE_ACCESS_TOKEN', 'GMAIL_ACCESS_TOKEN'] } },
    codex: { issuer: UP, api: UP + '/codex', pollMs: 40 },
  });
  assert.throws(() => App.create({ dataDir, accessKey: 'short' }), /CYB_ACCESS_KEY/, 'a server without a real access key does not start');
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => Store.open(path.join(dataDir, 'production-key-check')), /CYB_MASTER_KEY is required in production/, 'production refuses to generate an encryption key beside its data');
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  let app = App.create(cfgOf('http://placeholder')); let BASE = await listen(app.server);
  await app.close(); app = App.create(cfgOf(BASE.replace(/:\d+$/, ':0'))); // public address is only used to build the redirect; fixed below
  BASE = await listen(app.server);
  const call = async (method, p, body, token, headers) => {
    const r = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {}), body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {} return { status: r.status, json, text, headers: r.headers };
  };

  // ---------------------------------------------------------------- 1. registration and tokens
  let r = await call('GET', '/v1/health'); assert.ok(r.status === 200 && r.json.ok && r.json.languages.includes('fake') && r.json.signIn.includes('google') && r.json.signIn.includes('codex'));
  assert.strictEqual((await call('GET', '/v1/files')).status, 401, 'nothing works without a token');
  assert.strictEqual((await call('GET', '/v1/files', undefined, 'cyb_wrong')).status, 401);
  assert.strictEqual((await call('POST', '/v1/auth/register', { accessKey: 'nope' })).status, 403);
  const A = (await call('POST', '/v1/auth/register', { accessKey: 'test-access-key-123456', name: 'Asha', device: 'phone' })).json.token;
  const B = (await call('POST', '/v1/auth/register', { accessKey: 'test-access-key-123456', name: 'Bob' })).json.token;
  assert.ok(/^cyb_/.test(A) && A !== B);
  const rawDb = () => fs.readFileSync(path.join(dataDir, 'cybnate.db')).toString('latin1') + (fs.existsSync(path.join(dataDir, 'cybnate.db-wal')) ? fs.readFileSync(path.join(dataDir, 'cybnate.db-wal')).toString('latin1') : '');
  assert.ok(rawDb().indexOf(A) < 0, 'the token itself is not in the database, only its hash');
  assert.strictEqual((await call('OPTIONS', '/v1/exec')).status, 204, 'native preflight without an Origin remains supported');
  assert.strictEqual((await call('GET', '/v1/health')).headers.get('access-control-allow-origin'), null, 'responses without Origin do not emit a wildcard CORS grant');
  r = await call('GET', '/v1/health', undefined, undefined, { Origin: 'https://ui.cybnate.test' });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://ui.cybnate.test', 'configured browser origin is allowed exactly');
  r = await call('GET', '/v1/health', undefined, undefined, { Origin: 'https://attacker.example' });
  assert.strictEqual(r.status, 403, 'unconfigured browser origin is rejected');
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null, 'rejected origin receives no CORS grant');
  r = await call('OPTIONS', '/v1/exec', undefined, undefined, { Origin: 'https://attacker.example' });
  assert.strictEqual(r.status, 403, 'unconfigured preflight origin is rejected');
  assert.strictEqual((await call('GET', '/v1/nothing', undefined, A)).status, 404); assert.strictEqual((await call('PUT', '/v1/files', {}, A)).status, 405);
  console.log('1 registration ok');

  // ---------------------------------------------------------------- 2. files: write, list, read, refuse escapes
  const b64 = (s) => Buffer.from(s).toString('base64');
  r = await call('POST', '/v1/files/sync', { write: [{ path: 'src/main.py', b64: b64('print("hi from", __name__)\n') }, { path: 'notes.txt', text: 'one\n' }, { path: 'bin.dat', b64: Buffer.from([0, 255, 1, 254]).toString('base64') }] }, A);
  assert.deepStrictEqual([r.status, r.json.written], [200, 3]);
  r = await call('GET', '/v1/files', undefined, A); assert.deepStrictEqual(r.json.files.map((f) => f.path), ['bin.dat', 'notes.txt', 'src/main.py']);
  assert.strictEqual(r.json.files[0].size, 4); assert.strictEqual(r.json.files[1].sha1, require('node:crypto').createHash('sha1').update('one\n').digest('hex'));
  for (const bad of ['../escape.txt', '/etc/passwd', 'a/../../b', 'x\u0000y']) {
    r = await call('POST', '/v1/files/sync', { write: [{ path: 'ok.txt', text: 'x' }, { path: bad, text: 'x' }] }, A); assert.strictEqual(r.status, 400, bad);
  }
  assert.ok(!(await call('GET', '/v1/files', undefined, A)).json.files.some((f) => f.path === 'ok.txt'), 'a batch with a bad path writes nothing at all');
  assert.strictEqual((await call('POST', '/v1/files/read', { paths: ['../../cybnate.db'] }, A)).status, 400);
  r = await call('POST', '/v1/files/read', { paths: ['bin.dat', 'gone.txt'] }, A); assert.deepStrictEqual([...Buffer.from(r.json.files[0].b64, 'base64')], [0, 255, 1, 254]); assert.ok(r.json.files[1].missing);
  assert.deepStrictEqual((await call('GET', '/v1/files', undefined, B)).json.files, [], 'another user sees none of it');
  console.log('2 files ok');

  // ---------------------------------------------------------------- 3. commands: real output, changed files, time limit, stop, queue
  const run = (command, extra, token) => call('POST', '/v1/exec', Object.assign({ command }, extra || {}), token || A);
  r = await run('python3 src/main.py && echo two >> notes.txt && mkdir -p out && echo made > out/new.txt && rm bin.dat; echo err >&2; exit 3');
  assert.strictEqual(r.json.code, 3); assert.ok(/hi from __main__/.test(r.json.out) && /err/.test(r.json.out), r.json.out);
  assert.deepStrictEqual(r.json.changed.map((c) => c.path).sort(), ['notes.txt', 'out/new.txt']); assert.deepStrictEqual(r.json.deleted, ['bin.dat']);
  assert.strictEqual(Buffer.from(r.json.changed.find((c) => c.path === 'notes.txt').b64, 'base64').toString(), 'one\ntwo\n');
  r = await run('pwd; echo "home=$HOME"; env | grep -c CYB_ || true; echo "key=[$CYB_ACCESS_KEY]"', {}, A);
  assert.ok(/\/ws\n/.test(r.json.out) && /home=.*\/home\n/.test(r.json.out) && /key=\[\]/.test(r.json.out), 'the command sees its own folder and nothing of the server environment: ' + r.json.out);
  let t0 = Date.now(); r = await run('echo start; sleep 30; echo never', { timeoutSec: 1 });
  assert.ok(r.json.code === 124 && r.json.timedOut && /start/.test(r.json.out) && !/never/.test(r.json.out) && /Timed out after 1 s/.test(r.json.out) && Date.now() - t0 < 6000, JSON.stringify(r.json));
  r = await run('(sleep 300 &) ; sleep 300 & echo $! > pid.txt; wait', { timeoutSec: 1 }); const pid = Number(Buffer.from(r.json.changed.find((c) => c.path === 'pid.txt').b64, 'base64').toString());
  await sleep(300); assert.throws(() => process.kill(pid, 0), 'children of a timed-out command are killed too');
  // stop from the app: cancel by id
  const long = run('sleep 30; echo never', { id: 'job-1', timeoutSec: 60 }); await sleep(300);
  assert.ok((await call('POST', '/v1/exec/job-1/cancel', {}, A)).json.ok); r = await long; assert.ok(r.json.code === 130 && r.json.stopped && !/never/.test(r.json.out));
  // one user's commands run one after another; two users run side by side
  t0 = Date.now(); const both = await Promise.all([run('echo a >> order.txt; sleep 0.5; echo b >> order.txt'), run('echo c >> order.txt; sleep 0.5; echo d >> order.txt')]);
  assert.strictEqual((await call('POST', '/v1/files/read', { paths: ['order.txt'] }, A)).json.files.map((f) => Buffer.from(f.b64, 'base64').toString())[0].replace(/\n/g, ''), 'abcd'); assert.ok(both.every((x) => x.json.code === 0));
  t0 = Date.now(); await Promise.all([run('sleep 0.7', {}, A), run('sleep 0.7', {}, B)]); assert.ok(Date.now() - t0 < 1300, 'different users are not queued behind each other');
  // too many waiting: refused, not piled up
  const flood = await Promise.all([1, 2, 3, 4, 5, 6].map(() => run('sleep 0.3'))); assert.ok(flood.some((x) => x.status === 429) && flood.filter((x) => x.status === 200).length === 4, flood.map((x) => x.status).join());
  r = await run('head -c 2000000 /dev/zero | tr "\\0" x; echo; echo THE-END'); assert.ok(r.json.out.length < 450000 && /characters left out/.test(r.json.out) && /THE-END/.test(r.json.out), 'huge output is cut in the middle, the end is kept');
  r = await run('git init -q . && git add -A && git -c user.name=t -c user.email=t@t commit -qm first && git log --oneline | wc -l'); assert.ok(/^\s*1\s*$/m.test(r.json.out), 'real git works: ' + r.json.out);
  assert.strictEqual((await run('  ')).status, 400);
  // a long command keeps the connection alive with spaces, and still ends in one JSON answer; a failure is reported inside it
  let raw1 = await fetch(BASE + '/v1/exec', { method: 'POST', headers: { Authorization: 'Bearer ' + A, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'sleep 0.5; echo slow-done' }) }); let txt = await raw1.text();
  assert.ok(raw1.status === 200 && /^ {2,}\{/.test(txt) && /slow-done/.test(JSON.parse(txt).out), JSON.stringify(txt.slice(0, 40)));
  const q = [1, 2, 3, 4, 5, 6].map(() => fetch(BASE + '/v1/exec', { method: 'POST', headers: { Authorization: 'Bearer ' + A, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'sleep 0.4' }) }).then((x) => x.text()).then((t) => ({ t, j: JSON.parse(t) })));
  const late = (await Promise.all(q)).filter((x) => /^ /.test(x.t)); assert.ok(late.length >= 1 && late.every((x) => x.j.status === undefined || x.j.status >= 400));
  console.log('3 commands ok');

  // ---------------------------------------------------------------- 4. retries do not run twice
  r = await call('POST', '/v1/exec', { command: 'echo x >> count.txt; wc -l < count.txt' }, A, { 'Idempotency-Key': 'k1' });
  const again = await call('POST', '/v1/exec', { command: 'echo x >> count.txt; wc -l < count.txt' }, A, { 'Idempotency-Key': 'k1' });
  assert.ok(/^\s*1\s*$/m.test(r.json.out) && again.json.out === r.json.out && again.headers.get('idempotent-replay') === 'true');
  const two = await Promise.all([1, 2].map(() => call('POST', '/v1/exec', { command: 'sleep 0.3; echo y >> count2.txt; wc -l < count2.txt' }, A, { 'Idempotency-Key': 'k2' })));
  assert.ok(two.every((x) => /^\s*1\s*$/m.test(x.json.out)), 'a retry sent while the first is still running waits for it');
  r = await call('POST', '/v1/exec', { command: 'wc -l < count.txt' }, B, { 'Idempotency-Key': 'k1' }); assert.ok(!/^\s*1\s*$/m.test(r.json.out), 'keys are per user');
  console.log('4 idempotency ok');

  // ---------------------------------------------------------------- 5. secrets: stored encrypted, never returned, filled in on the server, hidden in output
  const SECRET = 'sk-live-SUPER-SECRET-98765';
  assert.strictEqual((await call('PUT', '/v1/secrets/MY_KEY', { value: SECRET }, A)).status, 200);
  assert.strictEqual((await call('PUT', '/v1/secrets/1bad', { value: 'x' }, A)).status, 400); assert.strictEqual((await call('PUT', '/v1/secrets/GMAIL_ACCESS_TOKEN', { value: 'x' }, A)).status, 409);
  r = await call('GET', '/v1/secrets', undefined, A); assert.deepStrictEqual(r.json.secrets.map((s) => s.name), ['MY_KEY']); assert.ok(r.text.indexOf(SECRET) < 0);
  assert.strictEqual((await call('GET', '/v1/secrets/MY_KEY', undefined, A)).status, 405, 'there is no call that reads a secret back');
  assert.ok(rawDb().indexOf(SECRET) < 0, 'the secret is not readable in the database file');
  r = await run('echo "len=${#MY_KEY} value=$MY_KEY"'); assert.ok(/len=0 value=$/m.test(r.json.out), 'a command that does not name the secret does not get it');
  r = await run('echo "len=${#MY_KEY} value=$MY_KEY"; echo $MY_KEY > leak.txt', { secrets: ['MY_KEY', 'NOT_THERE'] });
  assert.ok(/len=26 value=\*\*\*/.test(r.json.out) && r.json.out.indexOf(SECRET) < 0, r.json.out); assert.deepStrictEqual(r.json.missingSecrets, ['NOT_THERE']);
  assert.ok(/len=0/.test((await run('echo "len=${#MY_KEY}"', { secrets: ['MY_KEY'] }, B)).json.out), 'another user cannot name it');
  r = await call('POST', '/v1/http', { method: 'POST', url: UP + '/api/echo?k=$MY_KEY', headers: { Authorization: 'Bearer $MY_KEY', 'X-Key': '${MY_KEY}' }, body: '{"k":"$MY_KEY","other":"$HOME"}', secrets: ['MY_KEY'] }, A);
  const seen = up.calls.filter((c) => c.path === '/api/echo').pop();
  assert.ok(seen.headers.authorization === 'Bearer ' + SECRET && seen.headers['x-key'] === SECRET && seen.body === '{"k":"' + SECRET + '","other":"$HOME"}', 'the service got the real value; other $NAMES are left alone');
  assert.ok(r.json.status === 200 && r.text.indexOf(SECRET) < 0 && /Bearer \*\*\*/.test(r.json.text), 'and the app got it back hidden');
  assert.strictEqual((await call('POST', '/v1/http', { url: UP + '/api/echo', secrets: ['NOPE'] }, A)).status, 409);
  r = await call('POST', '/v1/http', { url: UP + '/api/redirect', headers: { Authorization: 'Bearer $MY_KEY' }, secrets: ['MY_KEY'] }, A);
  assert.strictEqual(JSON.parse(r.json.text).auth, '', 'a redirect to another host does not carry the credentials');
  assert.ok((await call('DELETE', '/v1/secrets/MY_KEY', undefined, A)).json.ok && (await call('GET', '/v1/secrets', undefined, A)).json.secrets.length === 0);
  // the guard for the server's own network (switched off above only so the test can reach its fake services)
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(Net.isPrivate(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.ok(!Net.isPrivate(ip), ip);
  await assert.rejects(Net.check('http://169.254.169.254/latest/meta-data', false), /own network/); await assert.rejects(Net.check('http://localhost:1/', false), /own network/); await assert.rejects(Net.check('file:///etc/passwd', false), /Only http/);
  console.log('5 secrets ok');

  // ---------------------------------------------------------------- 6. Google sign-in ends on the server
  const stateOf = (url) => new URL(url).searchParams.get('state');
  r = await call('POST', '/v1/oauth/google/start', { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }, A);
  const au = new URL(r.json.url); assert.ok(r.json.url.startsWith(UP + '/google/auth?') && au.searchParams.get('client_id') === 'g-client' && au.searchParams.get('code_challenge_method') === 'S256' && au.searchParams.get('access_type') === 'offline');
  assert.ok(/gmail\.readonly/.test(au.searchParams.get('scope')) && /\/v1\/oauth\/callback$/.test(au.searchParams.get('redirect_uri')) && r.text.indexOf('g-secret') < 0);
  assert.strictEqual((await call('GET', '/v1/oauth/callback?state=made-up&code=good-code')).status, 400, 'a made-up state is refused');
  r = await call('GET', '/v1/oauth/callback?state=' + stateOf(au.href) + '&code=bad-code'); assert.ok(r.status === 400 && /Bad code/.test(r.text));
  r = await call('GET', '/v1/oauth/callback?state=' + stateOf(au.href) + '&code=good-code'); assert.strictEqual(r.status, 400, 'a state works once');
  const st2 = stateOf((await call('POST', '/v1/oauth/google/start', { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }, A)).json.url);
  r = await call('GET', '/v1/oauth/callback?state=' + st2 + '&code=good-code'); assert.ok(r.status === 200 && /Connected to Google as asha@gmail\.com/.test(r.text), r.text);
  r = await call('GET', '/v1/oauth', undefined, A); const g = r.json.providers.find((p) => p.id === 'google');
  assert.ok(g.connected && g.who === 'asha@gmail.com' && g.scopes.some((s) => /gmail/.test(s)) && r.text.indexOf('ya29') < 0 && r.text.indexOf('g-refresh') < 0, 'the app learns who is connected, never a token');
  assert.ok(!(await call('GET', '/v1/oauth', undefined, B)).json.providers.find((p) => p.id === 'google').connected);
  assert.ok(rawDb().indexOf('g-refresh') < 0 && rawDb().indexOf('ya29.A1') < 0, 'tokens are encrypted at rest');
  r = await call('POST', '/v1/http', { url: UP + '/api/echo', headers: { Authorization: 'Bearer $GMAIL_ACCESS_TOKEN' }, secrets: ['GMAIL_ACCESS_TOKEN'] }, A);
  assert.strictEqual(up.calls.filter((c) => c.path === '/api/echo').pop().headers.authorization, 'Bearer ya29.A1'); assert.ok(r.text.indexOf('ya29') < 0);
  assert.ok(/tok=\*\*\*/.test((await run('echo tok=$GOOGLE_ACCESS_TOKEN', { secrets: ['GOOGLE_ACCESS_TOKEN'] })).json.out), 'commands get it by name as well');
  console.log('6 google sign-in ok');

  // ---------------------------------------------------------------- 7. Codex device sign-in, models (cached), streamed reply
  r = await call('POST', '/v1/oauth/codex/device', {}, A); assert.deepStrictEqual([r.json.code, r.json.url], ['ABCD-EFGH', UP + '/codex/device']);
  assert.strictEqual((await call('GET', '/v1/oauth/codex/status', undefined, A)).json.state, 'pending');
  for (let i = 0; i < 100 && (await call('GET', '/v1/oauth/codex/status', undefined, A)).json.state === 'pending'; i++) await sleep(30);
  r = await call('GET', '/v1/oauth/codex/status', undefined, A); assert.deepStrictEqual(r.json, { state: 'connected', email: 'asha@example.com', plan: 'plus' });
  assert.strictEqual((await call('GET', '/v1/llm/codex/models', undefined, B)).status, 401, 'another user is not signed in');
  r = await call('GET', '/v1/llm/codex/models', undefined, A); assert.strictEqual(r.json.models[0].slug, 'gpt-x');
  const n = up.calls.filter((c) => c.path === '/codex/models').length; r = await call('GET', '/v1/llm/codex/models', undefined, A);
  assert.ok(r.json.cached && up.calls.filter((c) => c.path === '/codex/models').length === n, 'the model list is cached');
  const sr = await fetch(BASE + '/v1/llm/codex/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + A, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-x', stream: true, input: [] }) });
  const parts = []; for await (const c of sr.body) parts.push(Buffer.from(c).toString());
  assert.ok(parts.length >= 2 && /Hi /.test(parts[0]) && /there/.test(parts.join('')), 'the reply arrives in pieces, not all at the end');
  const cx = up.calls.filter((c) => c.path === '/codex/responses').pop(); assert.ok(cx.headers['chatgpt-account-id'] === 'acc-9' && /^Bearer h\./.test(cx.headers.authorization) && JSON.parse(cx.body).model === 'gpt-x');
  console.log('7 codex ok');

  // ---------------------------------------------------------------- 8. language server: diagnostics after edits, requests, missing binary
  await call('POST', '/v1/files/sync', { write: [{ path: 'a.fk', text: 'fine\nthis has a BUG here\n' }] }, A);
  r = await call('POST', '/v1/lsp/diagnostics', { path: 'a.fk' }, A);
  assert.deepStrictEqual(r.json, { lang: 'fake', ready: true, items: [{ line: 2, column: 12, severity: 'error', message: 'BUG found', source: 'fake', code: '' }] });
  await run('sed -i "s/BUG/fix/" a.fk'); r = await call('POST', '/v1/lsp/diagnostics', { path: 'a.fk' }, A); assert.deepStrictEqual(r.json.items, [], 'a file changed by a command is read again');
  r = await call('POST', '/v1/lsp/diagnostics', { path: 'a.fk' }, A); assert.ok(r.json.ready && r.json.items.length === 0, 'asking again without a change answers at once');
  r = await call('POST', '/v1/lsp/fake/request', { method: 'textDocument/hover', path: 'a.fk', params: { position: { line: 1, character: 2 } } }, A); assert.strictEqual(r.json.result.contents, 'this has a fix here');
  assert.strictEqual((await call('POST', '/v1/lsp/fake/request', { method: 'nope/nope' }, A)).status, 502);
  assert.strictEqual(app.lsp.count(), 1); assert.strictEqual((await call('POST', '/v1/lsp/diagnostics', { path: 'x.unknown' }, A)).status, 404);
  await call('POST', '/v1/files/sync', { write: [{ path: 'b.zz', text: 'x' }] }, A);
  r = await call('POST', '/v1/lsp/diagnostics', { path: 'b.zz' }, A); assert.ok(r.status === 502 && /not installed on the server/.test(r.json.error), r.text);
  assert.strictEqual((await call('POST', '/v1/lsp/diagnostics', { path: '../x.fk' }, A)).status, 400);
  assert.ok((await call('DELETE', '/v1/lsp/fake', undefined, A)).json.ok && app.lsp.count() === 0);
  console.log('8 language server ok');

  // ---------------------------------------------------------------- 9. saved state: versions, conflicts, many writers
  assert.strictEqual((await call('GET', '/v1/state/chats', undefined, A)).status, 404);
  r = await call('PUT', '/v1/state/chats', { value: { n: 1 }, baseVersion: 0 }, A); assert.strictEqual(r.json.version, 1);
  r = await call('PUT', '/v1/state/chats', { value: { n: 99 }, baseVersion: 0 }, A); assert.ok(r.status === 409 && r.json.current.version === 1 && r.json.current.value.n === 1, 'a stale write is refused and told the current value');
  // 20 writers add 1 each, retrying on conflict: nothing is lost
  await call('PUT', '/v1/state/counter', { value: 0, baseVersion: 0 }, A);
  await Promise.all(Array.from({ length: 20 }, async () => { for (;;) { const cur = (await call('GET', '/v1/state/counter', undefined, A)).json; const w = await call('PUT', '/v1/state/counter', { value: cur.value + 1, baseVersion: cur.version }, A); if (w.status === 200) return; assert.strictEqual(w.status, 409); } }));
  assert.strictEqual((await call('GET', '/v1/state/counter', undefined, A)).json.value, 20);
  assert.strictEqual((await call('GET', '/v1/state/chats', undefined, B)).status, 404);
  console.log('9 state ok');

  // ---------------------------------------------------------------- 10. everything survives a restart; tokens renew; a dead sign-in is said plainly
  await app.close(); app = App.create(Object.assign(cfgOf('http://127.0.0.1:1'), {})); BASE = await listen(app.server);
  assert.strictEqual((await call('GET', '/v1/me', undefined, A)).status, 200, 'the phone stays signed in');
  assert.strictEqual((await call('GET', '/v1/state/counter', undefined, A)).json.value, 20);
  assert.ok((await call('GET', '/v1/files', undefined, A)).json.files.some((f) => f.path === 'src/main.py'));
  assert.strictEqual((await call('GET', '/v1/oauth/codex/status', undefined, A)).json.state, 'connected');
  assert.ok((await call('POST', '/v1/exec', { command: 'echo x' }, A, { 'Idempotency-Key': 'k1' })).json.out.trim() === '1', 'a retry after the restart still gets the first answer');
  // rewrite the stored sessions as nearly expired, the way time would
  const raw = new DatabaseSync(path.join(dataDir, 'cybnate.db')); const userA = raw.prepare('SELECT user FROM oauth WHERE provider = ?').get('google').user; raw.close();
  const expire = (prov) => { const s = app.store.oauthGet(userA, prov); s.exp = Date.now() + 5000; app.store.oauthPut(userA, prov, s); };
  expire('google'); expire('codex');
  const many = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/v1/http', { url: UP + '/api/echo', headers: { Authorization: 'Bearer $GMAIL_ACCESS_TOKEN' }, secrets: ['GMAIL_ACCESS_TOKEN'] }, A)));
  assert.ok(many.every((x) => x.status === 200) && up.googleRefreshes === 1, 'four requests at once renew the token once: ' + up.googleRefreshes);
  assert.strictEqual(up.calls.filter((c) => c.path === '/api/echo').pop().headers.authorization, 'Bearer ya29.A2');
  await call('GET', '/v1/llm/codex/models?fresh=1', undefined, A); assert.strictEqual(up.refreshes, 1); assert.strictEqual(app.store.oauthGet(userA, 'codex').refresh, 'cx-refresh-2');
  expire('google'); up.refuseRefresh = true;
  r = await call('POST', '/v1/http', { url: UP + '/api/echo', headers: { Authorization: 'Bearer $GMAIL_ACCESS_TOKEN' }, secrets: ['GMAIL_ACCESS_TOKEN'] }, A);
  assert.ok(r.status === 401 && /expired.*revoked.*Sign in again/i.test(r.json.error), r.text);
  assert.ok(!(await call('GET', '/v1/oauth', undefined, A)).json.providers.find((p) => p.id === 'google').connected, 'a revoked sign-in is shown as not connected');
  // sign out of the server
  assert.ok((await call('POST', '/v1/auth/logout', {}, A)).json.ok); assert.strictEqual((await call('GET', '/v1/me', undefined, A)).status, 401);
  // a wrong master key cannot read what was stored
  await app.close();
  const other = App.create(Object.assign(cfgOf('http://x'), { masterKey: 'ab'.repeat(32) })); assert.throws(() => other.store.oauthGet(userA, 'codex')); await other.close();
  console.log('10 persistence ok');

  upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('ALL SERVER TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
