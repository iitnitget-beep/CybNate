// The HTML preview must never run inside the app page when the native bridge exists, and Stop must reach the shell.
// Run: NODE_PATH=<dir with jsdom> node tests/preview.test.js
const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');

(async () => {
  const calls = [];
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = {};
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.fetch = async () => { throw new Error('offline'); };
      // fake bridge: records every call; exec never answers by itself, like a long-running command
      w.Native = new Proxy({}, { get: (_, name) => (...a) => { calls.push([name].concat(a)); return name === 'wsList' ? '{}' : name === 'version' ? 'test' : ''; } });
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T, 'app started');

  T.ws.set('page.html', '<h1>hi</h1><script>Native.exec("x", "rm -rf .", 5)</script>');
  T.openPreview('page.html');
  const open = calls.filter((c) => c[0] === 'openPreview');
  assert.strictEqual(open.length, 1, 'preview goes to the separate native view');
  assert.ok(/rm -rf/.test(open[0][2]), 'page html handed over');
  assert.strictEqual(d.querySelectorAll('iframe').length, 0, 'no iframe in the page that owns the bridge');
  assert.ok(!calls.some((c) => c[0] === 'exec'), 'nothing was executed');

  const ctl = new w.AbortController();
  const run = T.runCommand('sleep 60', 60, ctl.signal);
  for (let i = 0; i < 100 && !calls.some((c) => c[0] === 'exec'); i++) await new Promise((r) => setTimeout(r, 20));
  const ex = calls.find((c) => c[0] === 'exec'); assert.ok(ex, 'shell command started');
  ctl.abort();
  assert.ok(calls.some((c) => c[0] === 'execAbort' && c[1] === ex[1]), 'Stop is passed to the native shell with the same id');
  w.__nx(ex[1], { code: 130, out: '', changed: [], deleted: [] });
  const r = await run; assert.strictEqual(r.code, 130); assert.ok(/stopped by the user/.test(r.out));
  console.log('PREVIEW ISOLATION TEST PASSED');
  w.close();
})().catch((e) => { console.error(e); process.exit(1); });
