// One-tap pairing: pairBackend(url, key) — what a cybnate://pair link triggers —
// connects the backend without typing anything in Settings.
// Run: NODE_PATH=<dir with jsdom> node tests/pair.test.js
const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');

(async () => {
  const calls = [];
  const pairUrl = 'https://pair.example.com';
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: 'openrouter/free', keys: { openrouter: 'sk-test' } }), 'cyb.defaultBackendTried': '1' };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      const stream = (s) => { const chunks = [new TextEncoder().encode(s)]; return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) }; };
      w.fetch = async (url, opt) => {
        calls.push(url);
        let body = '{}';
        if (/\/v1\/health$/.test(url)) body = JSON.stringify({ ok: true, name: 'cybnate-server', version: '0.2.0', isolation: 'uid', languages: ['typescript', 'python'], signIn: ['codex'] });
        else if (/\/v1\/auth\/register$/.test(url)) body = JSON.stringify({ userId: 'u1', token: 'cyb_testtoken' });
        else if (/\/v1\/files$/.test(url)) body = JSON.stringify({ files: [] });
        else if (/\/v1\/files\/sync$/.test(url)) body = JSON.stringify({ ok: true, written: 0, removed: 0 });
        else if (/\/v1\/secrets/.test(url)) body = JSON.stringify({ ok: true, secrets: [] });
        return { status: 200, headers: { get: () => 'application/json', forEach: () => {} }, body: stream(body) };
      };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(w.__cyb, 'app started');
  assert.ok(!w.__cyb.backend.on(), 'no server before pairing');
  await w.__cyb.pairBackend(pairUrl, 'test-access-key-1234');
  assert.ok(w.__cyb.backend.on(), 'backend connected by pairBackend');
  assert.strictEqual(w.__cyb.settings.backend.url, pairUrl);
  assert.strictEqual(w.__cyb.settings.backend.token, 'cyb_testtoken');
  assert.ok(calls.some((u) => /\/v1\/auth\/register$/.test(u)), 'registered with the server');
  assert.ok(/Connected to pair\.example\.com/.test(w.document.querySelector('#sheetBody').textContent), 'Server sheet shows the connection');
  console.log('PAIR TEST PASSED');
  w.close();
})().catch((e) => { console.error(e); process.exit(1); });
