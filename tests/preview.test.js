// The HTML preview must never run inside the app page when the native bridge exists, and Stop must reach the shell.
// Run: NODE_PATH=<dir with jsdom> node tests/preview.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const paneSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'java', 'com', 'cybnate', 'app', 'PreviewPane.java'), 'utf8');
assert.match(paneSource, /ORIGIN = "https:\/\/preview\.cybnate\.invalid\//, 'preview has a separate HTTPS origin');
assert.match(paneSource, /setAllowFileAccess\(false\)/, 'preview cannot access local files');
assert.match(paneSource, /setDomStorageEnabled\(true\)/, 'preview DOM storage stays scoped to its origin');
assert.doesNotMatch(paneSource, /addJavascriptInterface\s*\(/, 'preview has no native JavaScript bridge');

(async () => {
  const calls = [], startupFetches = [];
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = {};
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.fetch = async (url) => { startupFetches.push(url); throw new Error('offline'); };
      // fake bridge: records every call; exec never answers by itself, like a long-running command
      w.Native = new Proxy({}, { get: (_, name) => (...a) => { calls.push([name].concat(a)); return name === 'wsList' ? '{}' : name === 'version' ? 'test' : ''; } });
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T, 'app started');
  assert.ok(!startupFetches.some((url) => /(?:babel\.min\.js|esm\.sh|cdn\.tailwindcss\.com|unpkg\.com)/i.test(String(url))), 'app startup does not fetch the compiler or preview CDNs');
  assert.doesNotThrow(() => new Function(w.ProjectPreview.BOOTSTRAP), 'preview bootstrap JavaScript parses');

  T.ws.set('page.html', '<h1>hi</h1><script>Native.exec("x", "rm -rf .", 5)</script>');
  T.openPreview('page.html');
  const open = calls.filter((c) => c[0] === 'openPreview');
  assert.strictEqual(open.length, 1, 'preview goes to the separate native view');
  assert.ok(/rm -rf/.test(open[0][2]), 'page html handed over');
  assert.strictEqual(d.querySelectorAll('iframe').length, 0, 'no iframe in the page that owns the bridge');
  assert.ok(!calls.some((c) => c[0] === 'exec'), 'nothing was executed');

  // Multi-file React + package manifest + Express route project is serialized for the isolated preview.
  T.ws.set('package.json', JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', express: '^4.21.0' } }));
  T.ws.set('src/main.jsx', "import React from 'react'; import App from './App'; import './style.css'; import { createRoot } from 'react-dom/client'; createRoot(document.getElementById('root')).render(<App />);");
  T.ws.set('src/App.jsx', "export default function App(){ return <main className='flex p-4'>Preview app</main> }");
  T.ws.set('src/style.css', 'body { color: #123; }');
  T.ws.set('backend/server.js', "const express = require('express'); const app = express(); app.get('/api/health', (req, res) => res.json({ ok: true })); app.listen(3000);");
  const compilerRequests = [];
  w.fetch = async (url) => { compilerRequests.push(url); assert.strictEqual(url, 'vendor/babel/babel.min.js', 'preview compiler is fetched only from the bundled app asset'); return { ok: true, text: async () => '/* local Babel fixture */' }; };
  T.openPreview('src/main.jsx');
  for (let i = 0; i < 100 && calls.filter((c) => c[0] === 'openPreview').length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const projectPreview = calls.filter((c) => c[0] === 'openPreview').pop()[2];
  assert.deepStrictEqual(compilerRequests, ['vendor/babel/babel.min.js'], 'React preview loads Babel lazily from the bundled asset');
  assert.ok(projectPreview.includes('local Babel fixture'), 'the local compiler is embedded for the isolated preview');
  assert.doesNotMatch(projectPreview, /unpkg\.com\/@babel/, 'preview does not fetch Babel from a CDN');
  assert.match(projectPreview, /type="importmap"/, 'module import map is injected');
  assert.match(projectPreview, /react-dom\/client/, 'React DOM client is mapped');
  assert.match(projectPreview, /"entry":"src\/main.jsx"/, 'project entry is chosen');
  assert.match(projectPreview, /"apiPath":"backend\/server.js"/, 'Express entry is identified');
  assert.ok(projectPreview.includes('src/App.jsx'), 'multi-file source is embedded');
  assert.match(projectPreview, /cdn\.tailwindcss\.com/, 'Tailwind utility preview is enabled');
  assert.match(projectPreview, /__cybPreviewError/, 'runtime errors have an in-preview display');
  assert.strictEqual(d.querySelectorAll('iframe').length, 0, 'React preview is not placed in the bridge-owning page');
  assert.ok(!calls.some((c) => c[0] === 'exec'), 'preview source did not invoke the native bridge');

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
