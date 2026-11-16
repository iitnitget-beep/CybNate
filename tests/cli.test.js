// Built-in git / npm / curl (cli.js) and the JavaScript runtime's module loading (jsworker.js).
// The network is faked. Set CYB_NPM_CACHE=<dir with unpacked npm tarballs as name@version/> to also install real packages.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const C = require('../app/src/main/assets/www/core.js');
const Cli = require('../app/src/main/assets/www/cli.js');
const www = path.join(__dirname, '../app/src/main/assets/www');

/** Run jsworker.js the way the app's Worker does, inside this process. */
function runNode(ws, msg) {
  return new Promise((resolve) => {
    const self = { setTimeout, clearTimeout, setInterval, clearInterval, crypto: require('crypto').webcrypto, performance, URL, URLSearchParams, TextEncoder, TextDecoder, fetch: (...a) => fetch(...a), addEventListener: () => {}, postMessage: resolve };
    const src = fs.readFileSync(path.join(www, 'jsworker.js'), 'utf8');
    const importScripts = (name) => { if (name === 'url-policy.js') self.UrlPolicy = require(path.join(www, name)); else throw new Error('unexpected worker import: ' + name); };
    new Function('self', 'btoa', 'atob', 'importScripts', src)(self, (s) => Buffer.from(s, 'binary').toString('base64'), (s) => Buffer.from(s, 'base64').toString('binary'), importScripts);
    self.onmessage({ data: Object.assign({ files: ws.list().map((p) => ({ path: p, data: ws.bytes(p) })), mode: 'file', argv: [], src: '', cwd: '', env: {} }, msg) });
  });
}
function world(cdn) {
  const ws = new C.Workspace(); const store = {}; let repo = null; const log = { http: [], pushes: [], approvals: [] };
  const deps = {
    ws, matchGlob: C.matchGlob, kv: { get: async (k) => store[k], set: async (k, v) => { store[k] = v; } },
    now: (() => { let t = 1700000000000; return () => (t += 1000); })(),
    http: async (url, o) => { log.http.push([o.method, url, o.headers, o.body]); return cdn(url, o); },
    getRepo: () => repo, setRepo: (b) => { repo = b; }, token: () => 'tok', blob: async () => { throw new Error('offline'); },
    approvePush: async (req) => { log.approvals.push(req); return log.allow !== false; }, confirm: async () => log.allow !== false,
    run: async (cmd) => { const pc = C.parseCommand(cmd); if (pc.kind !== 'node') return { code: 1, out: 'unexpected ' + cmd }; const r = await runNode(ws, { mode: pc.mode, argv: pc.argv, src: pc.src || '', cwd: pc.cwd }); return { code: r.code, out: r.out, files: [] }; },
    GitHub: {
      parseRepo: (s) => { const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')); if (!m) throw new Error('not a GitHub repository: ' + s); return { owner: m[1], repo: m[2], branch: '' }; },
      blobSha: async (b) => 'sha-' + C.crc32(b),
      clone: async (o) => ({ files: new Map([['README.md', '# demo\n'], ['src/app.py', 'x = 1\n']]), skipped: 0, base: { owner: o.owner, repo: o.repo, branch: o.branch || 'main', commit: 'c0ffee0000000000', tree: 't', shas: {}, canPush: true } }),
      push: async (o) => { log.pushes.push(o); return { base: Object.assign({}, o.base, { branch: o.branch, commit: 'beef' + log.pushes.length + '00000000' }), commit: 'beef' + log.pushes.length + '00000000', changed: 1, url: 'https://github.com/x/y/commit/beef' }; },
    },
  };
  return { ws, cli: Cli.create(deps), log, deps, store, get repo() { return repo; } };
}
const run = (w, cmd) => { const pc = C.parseCommand(cmd); return pc.kind === 'git' ? w.cli.git(pc.argv) : pc.kind === 'npm' ? w.cli.npm(pc) : pc.kind === 'curl' ? w.cli.curl(pc.prog, pc.argv, pc.cwd) : Promise.reject(new Error('kind ' + pc.kind)); };

(async () => {
  // ------------------------------------------------------------ git
  let w = world(async () => ({ status: 404, text: '' }));
  let r = await run(w, 'git status'); assert.strictEqual(r.code, 128); assert.ok(/not a git repository/.test(r.out));
  w.ws.set('main.py', 'print(1)\n'); w.ws.set('node_modules/x/index.js', 'x'); w.ws.set('.gitignore', '*.log\nbuild/\n'); w.ws.set('a.log', 'l'); w.ws.set('build/o.txt', 'o');
  r = await run(w, 'git init'); assert.strictEqual(r.code, 0);
  r = await run(w, 'git status --short'); assert.strictEqual(r.out, '?? .gitignore\n?? main.py', 'node_modules and .gitignore patterns are left out');
  r = await run(w, 'git commit -m "first"'); assert.ok(/\[main [0-9a-f]{7}\] first/.test(r.out) && /2 files changed, 3 insertions/.test(r.out), r.out);
  r = await run(w, 'git status'); assert.ok(/working tree clean/.test(r.out));
  w.ws.set('main.py', 'print(1)\nprint(2)\n'); w.ws.set('new.txt', 'n\n'); w.ws.remove('.gitignore');
  r = await run(w, 'git status --short'); assert.strictEqual(r.out, ' M main.py\n D .gitignore\n?? a.log\n?? build/o.txt\n?? new.txt', 'with .gitignore deleted its patterns no longer hide files');
  r = await run(w, 'git diff main.py'); assert.ok(/^diff --git a\/main\.py b\/main\.py\n--- a\/main\.py\n\+\+\+ b\/main\.py\n@@ -1,1 \+1,2 @@\n print\(1\)\n\+print\(2\)$/.test(r.out), r.out);
  r = await run(w, 'git diff --stat'); assert.ok(/main\.py \| 1 \+/.test(r.out) && /5 files changed/.test(r.out), r.out);
  r = await run(w, 'git checkout -- main.py'); assert.strictEqual(w.ws.get('main.py'), 'print(1)\n'); assert.deepStrictEqual(r.files, ['main.py']);
  r = await run(w, 'git checkout -- nope.py'); assert.strictEqual(r.code, 1);
  r = await run(w, 'git restore .gitignore'); assert.ok(w.ws.has('.gitignore'));
  r = await run(w, 'git commit -am "second"'); assert.strictEqual(r.code, 0);
  r = await run(w, 'git log --oneline'); assert.ok(/^[0-9a-f]{7} \(HEAD -> main\) second\n[0-9a-f]{7} first$/.test(r.out), r.out);
  r = await run(w, 'git log -1'); assert.ok(/second/.test(r.out) && !/first/.test(r.out));
  r = await run(w, 'git branch'); assert.strictEqual(r.out, '* main');
  r = await run(w, 'git checkout -b feature/x'); assert.ok(/Switched to a new branch 'feature\/x'/.test(r.out));
  r = await run(w, 'git rev-parse --abbrev-ref HEAD'); assert.strictEqual(r.out, 'feature/x');
  r = await run(w, 'git push'); assert.strictEqual(r.code, 128); assert.ok(/no GitHub repository/.test(r.out));
  r = await run(w, 'git rebase main'); assert.strictEqual(r.code, 1); assert.ok(/not available/.test(r.out));
  // the repository survives a restart (state comes from storage)
  const w2 = world(async () => ({ status: 404, text: '' })); Object.assign(w2.store, w.store); w.ws.list().forEach((p) => w2.ws.set(p, w.ws.get(p)));
  r = await run(w2, 'git log --oneline'); assert.ok(/second/.test(r.out));
  console.log('GIT LOCAL TESTS PASSED');

  // clone / commit / push
  w = world(async () => ({ status: 404, text: '' })); w.ws.set('old.txt', 'x');
  w.log.allow = false; r = await run(w, 'git clone me/demo'); assert.strictEqual(r.code, 1); assert.ok(w.ws.has('old.txt'), 'a refused clone leaves the workspace alone');
  w.log.allow = true; r = await run(w, 'git clone https://github.com/me/demo.git'); assert.strictEqual(r.code, 0, r.out); assert.ok(!w.ws.has('old.txt') && w.ws.get('src/app.py') === 'x = 1\n');
  r = await run(w, 'git status'); assert.ok(/up to date with origin\/main/.test(r.out) && /working tree clean/.test(r.out), r.out);
  r = await run(w, 'git push'); assert.strictEqual(r.out, 'Everything up-to-date');
  w.ws.set('src/app.py', 'x = 2\n');
  r = await run(w, 'git push'); assert.strictEqual(r.code, 1); assert.ok(/uncommitted change/.test(r.out)); assert.strictEqual(w.log.pushes.length, 0);
  await run(w, 'git commit -m "fix: x is 2"');
  r = await run(w, 'git status'); assert.ok(/ahead of origin\/main by 1 commit/.test(r.out), r.out);
  w.log.allow = false; r = await run(w, 'git push'); assert.strictEqual(r.code, 1); assert.ok(/DENIED/.test(r.out)); assert.strictEqual(w.log.pushes.length, 0, 'nothing is pushed without the user');
  w.log.allow = true; r = await run(w, 'git push'); assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(w.log.pushes.length, 1); assert.strictEqual(w.log.pushes[0].message, 'fix: x is 2'); assert.strictEqual(w.log.pushes[0].branch, 'main');
  assert.deepStrictEqual(w.log.approvals.pop().files, ['M  src/app.py']); assert.strictEqual(w.repo.commit, 'beef100000000');
  r = await run(w, 'git push'); assert.strictEqual(r.out, 'Everything up-to-date');
  // a repository cloned by an older app version (no snapshot): unchanged files become the baseline, changed ones are reported honestly
  w = world(async () => ({ status: 404, text: '' })); w.ws.set('a.txt', 'same\n'); w.ws.set('b.txt', 'edited\n');
  w.deps.setRepo({ owner: 'me', repo: 'old', branch: 'main', commit: 'abc1234', shas: { 'a.txt': 'sha-' + C.crc32(w.ws.bytes('a.txt')), 'b.txt': 'sha-different' } });
  r = await run(w, 'git status --short'); assert.strictEqual(r.out, '', 'b.txt has an unknown original: not reported as modified');
  r = await run(w, 'git log --oneline'); assert.ok(/abc1234 \(HEAD -> main\) cloned from me\/old/.test(r.out));
  console.log('GIT REMOTE TESTS PASSED');

  // ------------------------------------------------------------ curl
  w = world(async (url, o) => (/missing/.test(url) ? { status: 404, ctype: 'text/plain', text: 'nope' } : /img/.test(url) ? { status: 200, ctype: 'image/png', text: '\ufffdPNG' } : { status: 200, ctype: 'application/json', headers: { 'x-test': '1' }, text: JSON.stringify({ method: o.method, body: o.body || null }) }));
  r = await run(w, 'curl -s https://api.test/users'); assert.strictEqual(r.out, '{"method":"GET","body":null}');
  r = await run(w, "curl -i -X PUT -H 'Authorization: Bearer abc' -H \"X-A: b\" -d '{\"a\":1}' https://api.test/u/1");
  assert.ok(/^HTTP 200\ncontent-type: application\/json\nx-test: 1\n\n\{"method":"PUT","body":"\{\\"a\\":1\}"\}$/.test(r.out), r.out);
  let last = w.log.http.pop(); assert.strictEqual(last[2].Authorization, 'Bearer abc'); assert.strictEqual(last[2]['X-A'], 'b'); assert.strictEqual(last[2]['Content-Type'], 'application/x-www-form-urlencoded');
  r = await run(w, 'curl --json \'{"q":1}\' https://api.test/s'); last = w.log.http.pop(); assert.strictEqual(last[0], 'POST'); assert.strictEqual(last[2]['Content-Type'], 'application/json');
  r = await run(w, 'curl -sf https://api.test/missing'); assert.strictEqual(r.code, 22);
  r = await run(w, 'curl -s https://api.test/missing'); assert.strictEqual(r.code, 0); assert.strictEqual(r.out, 'nope');
  r = await run(w, 'curl -s -o /dev/null -w "%{http_code}" https://api.test/missing'); assert.strictEqual(r.out, '404'); // the status-only idiom
  r = await run(w, 'curl -s -o out/data.json https://api.test/x'); assert.strictEqual(w.ws.get('out/data.json'), '{"method":"GET","body":null}'); assert.deepStrictEqual(r.files, ['out/data.json']);
  r = await run(w, 'curl -o a.png https://api.test/img'); assert.strictEqual(r.code, 23); assert.ok(!w.ws.has('a.png'), 'a binary download is refused, not saved corrupted');
  r = await run(w, 'curl http://localhost:3000/api'); assert.strictEqual(r.code, 7); assert.ok(/no server can listen/.test(r.out));
  r = await run(w, 'curl -F file=@a.txt https://api.test/up'); assert.strictEqual(r.code, 2);
  r = await run(w, 'wget https://api.test/files/report.json'); assert.ok(w.ws.has('report.json'));
  r = await run(w, 'wget -qO- https://api.test/x'); assert.strictEqual(r.out, '{"method":"GET","body":null}');
  console.log('CURL TESTS PASSED');

  // ------------------------------------------------------------ npm (synthetic packages)
  const fake = {
    'tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.2.3', main: 'lib/index', dependencies: { helper: '^2.0.0' } }),
    'tiny@1.2.3/lib/index.js': "const h = require('helper'); const u = require('./util'); const fs = require('fs'); module.exports = { shout: (s) => h.up(u.trim(s)) + '!' };",
    'tiny@1.2.3/lib/util.js': 'exports.trim = (s) => s.trim();',
    'helper@^2.0.0/package.json': JSON.stringify({ name: 'helper', version: '2.0.1', main: 'index.js', unpkg: 'dist/helper.umd.js' }),
    'helper@2.0.1/dist/helper.umd.js': "(function (g, f) { typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = f() : (g.helper = f()); })(this, function () { return { up: function (s) { return s.toUpperCase(); } }; });",
    'esmonly/package.json': JSON.stringify({ name: 'esmonly', version: '5.0.0', type: 'module', main: 'index.js' }),
    'esmonly@5.0.0/index.js': "import x from './x.js';\nexport default x;\n",
  };
  const cdnOf = (table) => async (url) => { const k = url.replace('https://cdn.jsdelivr.net/npm/', ''); return k in table ? { status: 200, ctype: 'text/plain', text: table[k] } : { status: 404, text: 'not found' }; };
  w = world(cdnOf(fake));
  r = await run(w, 'npm install tiny'); assert.strictEqual(r.code, 0, r.out);
  assert.ok(/added 2 packages/.test(r.out) && /tiny@1\.2\.3/.test(r.out) && /helper@2\.0\.1/.test(r.out), r.out);
  assert.deepStrictEqual(JSON.parse(w.ws.get('package.json')).dependencies, { tiny: '^1.2.3' });
  assert.strictEqual(JSON.parse(w.ws.get('node_modules/helper/package.json')).main, 'dist/helper.umd.js', 'the browser bundle is preferred');
  w.ws.set('app.js', "const t = require('tiny'); console.log(t.shout('  hi '));");
  let n = await runNode(w.ws, { argv: ['app.js'] }); assert.strictEqual(n.out, 'HI!\n', n.out); assert.strictEqual(n.code, 0);
  w.ws.set('pkg/deep/run.js', "console.log(require('tiny').shout('up'))"); // node_modules is found from a sub-folder
  n = await runNode(w.ws, { argv: ['pkg/deep/run.js'] }); assert.strictEqual(n.out, 'UP!\n', n.out);
  r = await run(w, 'npm install esmonly nosuchpkg'); assert.strictEqual(r.code, 1); assert.ok(/only ES modules/.test(r.out) && /nosuchpkg.*not found/.test(r.out), r.out); assert.ok(!w.ws.has('node_modules/esmonly/index.js'));
  r = await run(w, 'npm ls'); assert.ok(/helper@2\.0\.1/.test(r.out) && /tiny@1\.2\.3/.test(r.out));
  // npm test runs the package.json script
  const pj = JSON.parse(w.ws.get('package.json')); pj.scripts = { test: 'node test.js' }; w.ws.set('package.json', JSON.stringify(pj));
  w.ws.set('test.js', "const assert = require('assert'); assert.strictEqual(require('tiny').shout('a'), 'A!'); console.log('1 passing');");
  r = await run(w, 'npm test'); assert.strictEqual(r.code, 0, r.out); assert.ok(/> node test\.js\n1 passing/.test(r.out), r.out);
  w.ws.set('test.js', "require('assert').strictEqual(1, 2)"); r = await run(w, 'npm test'); assert.strictEqual(r.code, 1); assert.ok(/Expected 2 but got 1/.test(r.out) && /exited with code 1/.test(r.out), r.out);
  r = await run(w, 'npm run build'); assert.strictEqual(r.code, 1); assert.ok(/Missing script: "build"/.test(r.out));
  // a fresh checkout: `npm install` reads package.json
  const w3 = world(cdnOf(fake)); w3.ws.set('package.json', JSON.stringify({ name: 'a', dependencies: { tiny: '^1.2.3' } }));
  fake['tiny@^1.2.3/package.json'] = fake['tiny/package.json'];
  r = await run(w3, 'npm i'); assert.strictEqual(r.code, 0, r.out); assert.ok(w3.ws.has('node_modules/tiny/lib/util.js'));
  console.log('NPM TESTS PASSED');

  // ------------------------------------------------------------ JavaScript runtime modules
  const js = new C.Workspace();
  js.set('t.js', `
const assert = require('assert'), crypto = require('crypto'), { EventEmitter } = require('events'), url = require('url'), qs = require('querystring'), util = require('util'), path = require('path'), fs = require('node:fs');
assert.strictEqual(crypto.createHash('sha256').update('abc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.strictEqual(crypto.createHash('sha1').update('abc').digest('hex'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
assert.strictEqual(crypto.createHash('md5').update('The quick brown fox jumps over the lazy dog').digest('hex'), '9e107d9d372bb6826bd81d3542a419d6');
assert.strictEqual(crypto.createHash('sha256').update('a'.repeat(200)).digest('base64'), require('buffer').Buffer.from('c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5', 'hex').toString('base64'));
assert.strictEqual(crypto.createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
assert.strictEqual(crypto.randomBytes(16).length, 16); assert.ok(/^[0-9a-f-]{36}$/.test(crypto.randomUUID()));
assert.strictEqual(Buffer.from('héllo').toString('base64'), 'aMOpbGxv'); assert.strictEqual(Buffer.from('aMOpbGxv', 'base64').toString(), 'héllo'); assert.strictEqual(Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString('hex'), '6162');
const em = new EventEmitter(); let got = []; em.on('x', (v) => got.push(v)); em.once('x', (v) => got.push('once' + v)); em.emit('x', 1); em.emit('x', 2); assert.deepStrictEqual(got, [1, 'once1', 2]);
assert.strictEqual(url.parse('https://a.test:8080/p?x=1#h').port, '8080'); assert.deepStrictEqual(qs.parse('a=1&b=x%20y&a=2'), { a: ['1', '2'], b: 'x y' }); assert.strictEqual(qs.stringify({ a: [1, 2], b: 'x y' }), 'a=1&a=2&b=x%20y');
assert.strictEqual(util.format('%s=%d %j', 'n', 4, { a: 1 }), 'n=4 {\\n  "a": 1\\n}'); assert.strictEqual(path.relative('/a/b', '/a/c/d'), '../c/d');
fs.writeFileSync('out.bin', Buffer.from([1, 2, 3])); assert.strictEqual(fs.readFileSync('out.bin').toString('hex'), '010203');
let threw = ''; try { require('child_process').execSync('ls'); } catch (e) { threw = e.message; } assert.ok(/not available/.test(threw));
const express = require('express'), app = express(); app.get('/api/health', (req, res) => res.end('ok')); let response = ''; app.handle({ method: 'GET', url: '/api/health' }, { end: (value) => { response = value; } }); assert.strictEqual(response, 'ok'); const server = app.listen(3000); assert.strictEqual(server.listening, true); assert.deepStrictEqual(app._routes.map((r) => r.method + ' ' + r.path), ['GET /api/health']); server.close();
try { require('net'); } catch (e) { console.log(e.code); }
let ticks = 0; const id = setInterval(() => { if (++ticks === 3) { clearInterval(id); console.log('ticks', ticks); } }, 5);
util.promisify(fs.readFile)('out.bin').then((b) => console.log('async read', b.length));
console.log('sync done');
`);
  n = await runNode(js, { argv: ['t.js'] });
  assert.strictEqual(n.code, 0, n.out);
  assert.ok(/virtual express.*no network socket/.test(n.out) && /\[route\] GET \/api\/health/.test(n.out) && /MODULE_NOT_FOUND/.test(n.out) && /sync done\nasync read 3\nticks 3\n$/.test(n.out), n.out);
  assert.deepStrictEqual(n.changed.map((c) => c.path), ['out.bin']);
  console.log('JS RUNTIME TESTS PASSED');

  // ------------------------------------------------------------ real packages from an unpacked npm cache (optional)
  const cache = process.env.CYB_NPM_CACHE;
  if (cache && fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache);
    const real = async (url) => {
      const k = url.replace('https://cdn.jsdelivr.net/npm/', ''); const m = /^((?:@[^/]+\/)?[^/@]+)(?:@([^/]+))?\/(.*)$/.exec(k);
      const dir = dirs.find((d) => d.startsWith(m[1] + '@') && (!m[2] || /^[\^~]/.test(m[2]) || d === m[1] + '@' + m[2] || d.startsWith(m[1] + '@' + m[2] + '.')));
      const f = dir && path.join(cache, dir, m[3]);
      return f && fs.existsSync(f) && fs.statSync(f).isFile() ? { status: 200, ctype: 'text/plain', text: fs.readFileSync(f, 'utf8') } : { status: 404, text: '' };
    };
    w = world(real);
    r = await run(w, 'npm install lodash dayjs axios ms debug left-pad nanoid@3 chalk'); console.log(r.out);
    w.ws.set('real.js', `
const _ = require('lodash'), dayjs = require('dayjs'), ms = require('ms'), leftPad = require('left-pad'), axios = require('axios'), { nanoid } = require('nanoid');
console.log(_.chunk([1, 2, 3, 4, 5], 2), _.camelCase('hello big world'));
console.log(dayjs('2024-02-28').add(2, 'day').format('YYYY-MM-DD'));
console.log(ms('2 days'), leftPad('7', 3, '0'), typeof axios.get, nanoid().length);
console.log(typeof require('debug'));
`);
    n = await runNode(w.ws, { argv: ['real.js'] }); console.log(n.out);
    assert.strictEqual(n.code, 0); assert.ok(/helloBigWorld/.test(n.out) && /2024-03-01/.test(n.out) && /172800000 007 function 21/.test(n.out), n.out);
    assert.ok(/chalk.*only ES modules/.test(r.out), 'an ESM-only package is refused with the reason');
    console.log('REAL PACKAGE TESTS PASSED');
  }
  console.log('ALL CLI TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
