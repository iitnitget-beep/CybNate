// The app against a REAL CybNate server (server/) on a local port: pairing in Settings → Server, commands,
// file transfer both ways, secrets, sign-ins that end on the server, stop, and a dead server.
// The app runs in jsdom; its native HTTP bridge is wired to real HTTP. OpenAI and Google are small fake servers.
// Run: NODE_PATH=<dir with jsdom> node tests/backend.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const C = require(path.join(www, 'core.js'));
const B = require(path.join(www, 'backend.js'));
const App = require(path.join(__dirname, '..', 'server', 'src', 'app.js'));

// ---- small pieces without a browser
for (const bytes of [[], [1], [1, 2], [0, 255, 128, 7], Array.from({ length: 1000 }, (_, i) => (i * 37) % 256)]) {
  const enc = B.b64(Uint8Array.from(bytes)); assert.strictEqual(enc, Buffer.from(bytes).toString('base64')); assert.deepStrictEqual([...B.unb64(enc)], bytes);
}
assert.strictEqual(B.cleanUrl(' my.server.dev/ '), 'https://my.server.dev'); assert.strictEqual(B.cleanUrl('http://10.0.0.5:8787//'), 'http://10.0.0.5:8787');
const prompt = C.buildSystemPrompt('coder', '', '', { server: true, secrets: ['MY_KEY'] });
assert.ok(/Linux server/.test(prompt) && /`lsp <file>`/.test(prompt) && /secrets on the server: MY_KEY/.test(prompt) && !/Android system shell/.test(prompt) && !/WebAssembly/.test(prompt), 'the agent is told where commands run');
assert.ok(/You are on an Android phone/.test(C.buildSystemPrompt('coder', '', '', { shell: true })), 'and without a server the old text stays');
console.log('pieces ok');

let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIPPED the app part: jsdom is not installed'); process.exit(0); }
const jwt = (o) => 'h.' + Buffer.from(JSON.stringify(o)).toString('base64url') + '.s';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));

(async () => {
  const up = { calls: [], polls: 0 };
  const upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); up.calls.push({ path: u.pathname, headers: req.headers, body });
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const f = Object.fromEntries(new URLSearchParams(body));
      if (u.pathname === '/api/echo') return json(200, { auth: req.headers.authorization || '' });
      if (u.pathname === '/api/accounts/deviceauth/usercode') return json(200, { device_auth_id: 'd1', user_code: 'SRVR-1234', interval: '5' });
      if (u.pathname === '/api/accounts/deviceauth/token') { up.polls++; return up.polls < 2 ? json(403, {}) : json(200, { authorization_code: 'c1', code_verifier: 'v1' }); }
      if (u.pathname === '/oauth/token') return json(200, { id_token: jwt({ email: 'asha@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc-1' } }), access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'cx-refresh-SECRET' });
      if (u.pathname === '/codex/models') return json(200, { models: [{ slug: 'gpt-big', visibility: 'list', priority: 1 }, { slug: 'gpt-small', visibility: 'list', priority: 2 }] });
      if (u.pathname === '/codex/responses') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello from the plan"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{}}\n\n'); }
      if (u.pathname === '/google/token') return f.code === 'g-code' && f.client_secret === 'g-secret' ? json(200, { access_token: 'ya29.SERVER-ONLY', refresh_token: 'g-refresh-SECRET', expires_in: 3600, scope: f.code_verifier ? up.scope : '' }) : json(400, { error: 'invalid_grant' });
      if (u.pathname === '/google/userinfo') return json(200, { email: 'asha@gmail.com' });
      json(404, {});
    });
  });
  // The built-in curl refuses loopback addresses, so the fake outside world listens on this machine's network address.
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) { console.log('SKIPPED the app part: this machine has no network address besides loopback'); process.exit(0); }
  const UP = await new Promise((r) => upstream.listen(0, '0.0.0.0', () => r('http://' + lan.address + ':' + upstream.address().port)));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyb-app-'));
  const ACCESS = 'pairing-key-for-the-test';
  const cfg = (publicUrl) => ({ dataDir, accessKey: ACCESS, publicUrl, allowPrivate: true, beatMs: 200,
    lspServers: { fake: { cmd: [process.execPath, path.join(__dirname, '..', 'server', 'test', 'fake-lsp.js')], ext: ['fk'], ids: { fk: 'fake' } } },
    oauthProviders: { google: { name: 'Google', authUrl: UP + '/google/auth', tokenUrl: UP + '/google/token', clientId: 'g-client', clientSecret: 'g-secret', baseScopes: ['openid', 'email'], scopeSep: ' ', extra: {}, who: { url: UP + '/google/userinfo', field: 'email' }, secrets: ['GOOGLE_ACCESS_TOKEN', 'GMAIL_ACCESS_TOKEN', 'GCAL_ACCESS_TOKEN'] } },
    codex: { issuer: UP, api: UP + '/codex', pollMs: 30 } });
  // the public address must be known before the server starts: take a free port first
  const probe = http.createServer(); const free = await listen(probe); await new Promise((r) => probe.close(r));
  let server = App.create(cfg(free)); await new Promise((r) => server.server.listen(Number(free.split(':').pop()), '127.0.0.1', r)); const BASE = free;

  const nativeExec = []; const gcalls = []; const aborts = {};
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: 'qwen/qwen3-coder:free', keys: { openrouter: 'sk-test' }, models: { openrouter: ['qwen/qwen3-coder:free'] }, nativeTools: false, permission: 'auto', secrets: [{ name: 'MY_KEY', value: 'sk-live-PHONE-SECRET-4242' }] }) };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.__store = store; w.confirm = () => true;
      w.fetch = async () => { throw new TypeError('blocked'); };
      w.Native = {
        version: () => 'test',
        // the real bridge: an HTTP request made outside the page, the answer handed back in pieces
        http(id, url, method, headersJson, body) {
          const ctl = new AbortController(); aborts[id] = ctl;
          fetch(url, { method, headers: JSON.parse(headersJson || '{}'), body: method === 'GET' || method === 'HEAD' || !body ? undefined : body, signal: ctl.signal })
            .then(async (r) => { w.__nh(id, 'h', r.status + '|' + (r.headers.get('content-type') || '')); for await (const c of r.body) w.__nh(id, 'd', Buffer.from(c).toString('utf8')); w.__nh(id, 'x', ''); })
            .catch((e) => { if (!ctl.signal.aborted) w.__nh(id, 'e', String(e.cause && e.cause.code ? e.cause.code : e.message)); });
        },
        httpAbort(id) { if (aborts[id]) aborts[id].abort(); },
        exec(id, cmd) { nativeExec.push(cmd); setTimeout(() => w.__nx(id, { code: 0, out: 'ran on the phone', changed: [], deleted: [] }), 3); },
        wsWrite() { return ''; }, wsDelete() {}, wsList() { return '{}'; },
        googleAuth(id) { gcalls.push(id); setTimeout(() => w.__ga(id, { ok: false, error: 'not expected' }), 3); },
      };
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T && T.backend, 'app started');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));
  const until = async (fn, what, n) => { for (let i = 0; i < (n || 400); i++) { if (await fn()) return; await tick(25); } assert.fail('timed out: ' + what); };
  const storedText = () => Object.keys(w.__store).map((k) => w.__store[k]).join('\n');
  const stored = () => JSON.parse(w.__store['cyb.settings']);
  const serverFile = (p) => { const base = path.join(dataDir, 'users'); const u = fs.readdirSync(base)[0]; const f = path.join(base, u, 'ws', p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };

  // 1. before: no server, commands run on the phone
  T.ws.set('main.py', 'print("sum", 2 + 3)\n'); T.ws.set('notes/todo.txt', 'buy milk\n');
  assert.ok(!T.backend.on());
  let r = await T.runCommand('ls'); assert.ok(/ran on the phone/.test(r.out) && nativeExec.length === 1);

  // 2. Settings → Server: a wrong key and a wrong address say so; the right one connects, sends the files and moves the secret
  T.openServer(); await tick();
  const set = (id, v) => { const i = d.getElementById(id); i.value = v; i.oninput(); };
  set('srvUrl', BASE); set('srvKey', 'wrong-key-wrong-key'); d.getElementById('srvGo').click();
  await until(() => d.getElementById('srvMsg'), 'refusal shown'); assert.ok(/access key is wrong/.test(d.getElementById('srvMsg').textContent)); assert.ok(!T.backend.on());
  set('srvUrl', UP); set('srvKey', ACCESS); d.getElementById('srvGo').click();
  await until(() => d.getElementById('srvMsg') && /does not answer like a CybNate server/.test(d.getElementById('srvMsg').textContent), 'another kind of server is recognised');
  set('srvUrl', BASE + '/'); set('srvKey', ACCESS); d.getElementById('srvGo').click();
  await until(() => d.getElementById('srvState'), 'connected');
  assert.ok(/Connected to 127\.0\.0\.1/.test(d.getElementById('srvState').textContent) && /2 files sent, 1 secret moved/.test(d.getElementById('sheetBody').textContent), d.getElementById('sheetBody').textContent);
  await until(() => /Language servers/.test(d.getElementById('sheetBody').textContent), 'server facts shown');
  assert.ok(/No \(one user\)/.test(d.getElementById('sheetBody').textContent) && /ChatGPT/.test(d.getElementById('sheetBody').textContent));
  assert.strictEqual(serverFile('main.py'), 'print("sum", 2 + 3)\n'); assert.strictEqual(serverFile('notes/todo.txt'), 'buy milk\n');
  assert.ok(storedText().indexOf('sk-live-PHONE-SECRET-4242') < 0, 'the secret value is gone from the phone');
  assert.deepStrictEqual(stored().secrets, [{ name: 'MY_KEY', value: '', remote: true }]);
  assert.ok(storedText().indexOf(ACCESS) < 0, 'the pairing key is not kept either');
  console.log('1-2 pairing ok');

  // 3. commands run on the server; files travel both ways
  const before = nativeExec.length;
  r = await T.runCommand('python3 main.py | tr a-z A-Z && uname -s && echo made > out/result.txt 2>/dev/null || (mkdir -p out && echo made > out/result.txt) ; rm notes/todo.txt');
  assert.ok(/SUM 5/.test(r.out) && /Linux/.test(r.out), r.out); assert.strictEqual(T.ws.get('out/result.txt'), 'made\n'); assert.ok(!T.ws.has('notes/todo.txt'), 'a file the command deleted is gone on the phone');
  assert.ok(r.files.includes('out/result.txt') && r.files.includes('notes/todo.txt (deleted)'));
  T.ws.set('main.py', 'print("edited on the phone")\n'); T.ws.remove('out/result.txt'); T.ws.set('bin.dat', w.Uint8Array.from([0, 255, 10, 13, 128]));
  r = await T.runCommand('python3 main.py; ls out | wc -l; od -An -tu1 bin.dat'); assert.ok(/edited on the phone/.test(r.out) && /^\s*0\s*$/m.test(r.out) && /0\s+255\s+10\s+13\s+128/.test(r.out), r.out);
  r = await T.runCommand("python - <<'CYB_PY_EOF'\nimport json, sys\nopen('data.json','w').write(json.dumps({'v': sys.version_info[0]}))\nprint('written')\nCYB_PY_EOF"); assert.ok(/written/.test(r.out) && JSON.parse(T.ws.get('data.json')).v === 3, 'execute_python runs real Python on the server: ' + r.out);
  r = await T.runCommand('node -e "require(\'fs\').writeFileSync(\'n.txt\', String(6*7)); console.log(process.platform)"'); assert.ok(/linux/.test(r.out) && T.ws.get('n.txt') === '42');
  r = await T.runCommand('exit 7'); assert.strictEqual(r.code, 7);
  r = await T.runCommand('echo start; sleep 20', 1); assert.ok(r.code === 124 && r.timedOut && /Timed out after 1 s/.test(r.out));
  assert.strictEqual(nativeExec.length, before, 'nothing ran in the phone shell');
  console.log('3 commands ok');

  // 4. secrets: by name only, filled in on the server, hidden in what comes back
  r = await T.runCommand('echo "len=${#MY_KEY} v=$MY_KEY"', 30, null, ['MY_KEY']); assert.ok(/len=25 v=\*\*\*/.test(r.out) && r.out.indexOf('PHONE-SECRET') < 0, r.out);
  r = await T.runCommand('echo "len=${#MY_KEY}"'); assert.ok(/len=0/.test(r.out), 'not named, not passed');
  r = await T.runCommand("curl -s -H 'Authorization: Bearer $MY_KEY' " + UP + '/api/echo', 30, null, ['MY_KEY']);
  assert.strictEqual(up.calls.filter((c) => c.path === '/api/echo').pop().headers.authorization, 'Bearer sk-live-PHONE-SECRET-4242', 'the service got the real value from the server');
  assert.ok(/Bearer \*\*\*/.test(r.out) && r.out.indexOf('PHONE-SECRET') < 0, r.out);
  T.setSecret('SECOND', 'second-value-9999'); await T.secretsUp();
  assert.ok(storedText().indexOf('second-value-9999') < 0); r = await T.runCommand('echo "n=${#SECOND}"', 30, null, ['SECOND']); assert.ok(/n=17/.test(r.out));
  T.setSecret('SECOND', ''); await until(async () => /n=0/.test((await T.runCommand('echo "n=${#SECOND}"', 30, null, ['SECOND'])).out), 'a removed secret is removed on the server');
  console.log('4 secrets ok');

  // 5. language server
  T.ws.set('a.fk', 'ok line\nhere is a BUG\n'); r = await T.runCommand('lsp a.fk');
  assert.ok(r.code === 1 && /a\.fk:2:11 error: BUG found/.test(r.out) && /1 problem \(1 error\)/.test(r.out), r.out);
  T.ws.set('a.fk', 'ok line\nfixed\n'); r = await T.runCommand('lsp a.fk'); assert.ok(r.code === 0 && /no problems found/.test(r.out), r.out);
  r = await T.runCommand('lsp readme.unknownext'); assert.ok(r.code === 2 && /language server/i.test(r.out), r.out);
  console.log('5 language server ok');

  // 6. stop: the command ends on the server too
  const ctl = new w.AbortController(); const t0 = Date.now(); const long = T.runCommand('echo $$ > pid.txt; sleep 60', 120, ctl.signal);
  await tick(700); ctl.abort(); r = await long; assert.ok(Date.now() - t0 < 5000 && r.stopped && r.code === 130, JSON.stringify(r).slice(0, 200));
  const pid = Number(T.ws.get('pid.txt')); await tick(300); assert.throws(() => process.kill(pid, 0), 'the process is really gone');
  console.log('6 stop ok');

  // 7. ChatGPT sign-in ends on the server; the phone gets a name and a plan, never a token
  T.codexSignIn.intervalMs = 30; T.openProviders(); await tick();
  d.getElementById('codexGo').click(); await until(() => d.getElementById('codexCode'), 'code shown'); assert.strictEqual(d.getElementById('codexCode').textContent, 'SRVR-1234');
  await until(() => d.getElementById('codexState'), 'connected'); assert.ok(/asha@example\.com/.test(d.getElementById('codexState').textContent) && /Plus/.test(d.getElementById('codexState').textContent) && /2 models/.test(d.getElementById('codexState').textContent), d.getElementById('codexState').textContent);
  assert.ok(storedText().indexOf('cx-refresh-SECRET') < 0 && !/"access":"h\./.test(storedText()) && stored().codex.remote === true);
  const got = await T.chatStream([{ role: 'system', content: 'S' }, { role: 'user', content: 'hello' }], () => {}, null, null, { chain: [{ provider: 'codex', model: 'gpt-big' }] });
  assert.ok(/Hello from the plan/.test(JSON.stringify(got)), JSON.stringify(got).slice(0, 300));
  const cx = up.calls.filter((c) => c.path === '/codex/responses').pop(); assert.ok(/^Bearer h\./.test(cx.headers.authorization) && cx.headers['chatgpt-account-id'] === 'acc-1' && JSON.parse(cx.body).model === 'gpt-big', 'the server added the token');
  d.getElementById('codexOut').click(); await until(() => server.store.oauthGet(fs.readdirSync(path.join(dataDir, 'users'))[0], 'codex') === null, 'signing out removes it on the server'); assert.ok(!stored().codex);
  console.log('7 chatgpt ok');

  // 8. Google sign-in ends on the server
  const gmail = w.Integrations.BY_ID.gmail; up.scope = ['openid', 'email'].concat(gmail.scopes).join(' ');
  w.__cyb.googleConnect.x = 1; let authUrl = ''; const conn = T.googleConnect(gmail, (u) => { authUrl = u; });
  await until(() => authUrl, 'the Google address is known');
  const au = new URL(authUrl); assert.ok(authUrl.startsWith(UP + '/google/auth?') && au.searchParams.get('redirect_uri') === BASE + '/v1/oauth/callback' && gmail.scopes.every((sc) => au.searchParams.get('scope').includes(sc)));
  const page = await fetch(BASE + '/v1/oauth/callback?state=' + au.searchParams.get('state') + '&code=g-code'); assert.ok(page.status === 200 && /Connected to Google as asha@gmail\.com/.test(await page.text())); // what the phone's browser does after the login
  r = await conn; assert.deepStrictEqual([r.ok, r.who], [true, 'asha@gmail.com']); assert.strictEqual(gcalls.length, 0, 'Play services were not used');
  assert.ok(stored().integrations.gmail.server && stored().secrets.some((x) => x.name === 'GMAIL_ACCESS_TOKEN' && x.remote && !x.value) && storedText().indexOf('ya29') < 0 && storedText().indexOf('g-refresh') < 0);
  r = await T.runCommand("curl -s -H 'Authorization: Bearer $GMAIL_ACCESS_TOKEN' " + UP + '/api/echo', 30, null, ['GMAIL_ACCESS_TOKEN']);
  assert.strictEqual(up.calls.filter((c) => c.path === '/api/echo').pop().headers.authorization, 'Bearer ya29.SERVER-ONLY'); assert.ok(r.out.indexOf('ya29') < 0);
  console.log('8 google ok');

  // 9. the server restarts: the phone is still signed in, files are compared again; then the server is down: said plainly, no silent fallback
  await server.close(); server = App.create(cfg(BASE)); await new Promise((res) => server.server.listen(Number(BASE.split(':').pop()), '127.0.0.1', res));
  r = await T.runCommand('cat main.py'); assert.ok(/edited on the phone/.test(r.out));
  await server.close(); const n0 = nativeExec.length;
  await assert.rejects(T.runCommand('echo hi'), /Could not reach the server at 127\.0\.0\.1/); assert.strictEqual(nativeExec.length, n0, 'a command is never run on the phone behind the user\'s back');
  T.ws.set('offline.txt', 'written while the server was away\n');
  server = App.create(cfg(BASE)); await new Promise((res) => server.server.listen(Number(BASE.split(':').pop()), '127.0.0.1', res));
  r = await T.runCommand('cat offline.txt'); assert.ok(/written while the server was away/.test(r.out), 'changes made meanwhile arrive afterwards: ' + r.out);
  console.log('9 restart and outage ok');

  // 10. disconnect: the phone forgets the server and works on its own again
  T.openServer(); await until(() => d.getElementById('srvOff'), 'disconnect button'); d.getElementById('srvOff').click();
  await until(() => !T.backend.on(), 'disconnected'); assert.ok(!stored().backend && !(stored().secrets || []).length && !stored().integrations.gmail);
  r = await T.runCommand('ls'); assert.ok(/ran on the phone/.test(r.out));
  assert.strictEqual((await fetch(BASE + '/v1/me', { headers: { Authorization: 'Bearer x' } })).status, 401);
  console.log('10 disconnect ok');

  await server.close(); upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('ALL BACKEND APP TESTS PASSED'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
