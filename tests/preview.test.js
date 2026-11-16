// The HTML preview must never run inside the app page when the native bridge exists, and Stop must reach the shell.
// Run: NODE_PATH=<dir with jsdom> node tests/preview.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const WebTest = require('../app/src/main/assets/www/webtest.js');
const selftestSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'selftest.js'), 'utf8');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const paneSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'java', 'com', 'cybnate', 'app', 'PreviewPane.java'), 'utf8');
const testerSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'java', 'com', 'cybnate', 'app', 'PageTester.java'), 'utf8');
assert.match(paneSource, /ORIGIN = "https:\/\/preview\.cybnate\.invalid\//, 'preview has a separate HTTPS origin');
assert.match(paneSource, /setAllowFileAccess\(false\)/, 'preview cannot access local files');
assert.match(paneSource, /setDomStorageEnabled\(true\)/, 'preview DOM storage stays scoped to its origin');
assert.doesNotMatch(paneSource, /addJavascriptInterface\s*\(/, 'preview has no native JavaScript bridge');
assert.match(paneSource, /AssetsPathHandler\(act\)/, 'isolated preview serves bundled JS runtimes through WebViewAssetLoader');
assert.match(testerSource, /AssetsPathHandler\(act\)/, 'PageTester serves bundled JS runtimes without a native bridge');
assert.match(selftestSource, /TEST_TIMEOUT_MS = 12000/, 'each on-device self-test case has a strict 12-second ceiling');
assert.match(selftestSource, /SUITE_TIMEOUT_MS = 8 \* 60 \* 1000/, 'the entire device self-test leaves margin before the 10-minute CI sentinel deadline');
assert.match(selftestSource, /remote wheel download is outside the bounded offline\/device smoke test/, 'device self-test does not hang on an unbounded remote Pyodide wheel download');

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
  assert.strictEqual(w.ProjectPreview.resolveEntry({ 'rn/index.html': '', 'rn/src/main.jsx': '' }, 'rn/index.html', '<script type="module" src="./src/main.jsx"></script>'), 'rn/src/main.jsx', 'nested HTML entry resolves project-relative source paths');
  const nestedProjectHtml = w.ProjectPreview.projectHtml('rn/index.html', { 'rn/index.html': '<!doctype html><div id="root"></div><script type="module" src="./src/main.jsx"></script>', 'rn/src/main.jsx': "import { AppRegistry } from 'react-native';", 'backend/server.js': "const express = require('express'); const app = express(); app.get('/api/health', (req,res) => res.json({ok:true}));" }, { testMode: true });
  assert.match(nestedProjectHtml, /"entry":"rn\/src\/main\.jsx"/, 'nested React HTML keeps its actual module entry instead of selecting backend/server.js');
  assert.match(nestedProjectHtml, /"apiPath":"backend\/server\.js"/, 'nested React HTML still identifies its virtual API entry');

  const blank = new JSDOM(WebTest.instrument('<!doctype html><div id="root"></div><script>window.__CYB_PROJECT={entry:"src/App.jsx"}</script>', '', 0, 'blank'), { runScripts: 'dangerously', pretendToBeVisual: true });
  await new Promise((r) => setTimeout(r, 30));
  const blankReport = JSON.parse(blank.window.__cybResult);
  assert.ok(blankReport && blankReport.errors.some((e) => /blank #root/.test(e)), 'test_webapp flags React projects that leave #root blank');
  assert.strictEqual(WebTest.format(blankReport, 'index.html').code, 1, 'blank React root fails test_webapp verification');
  blank.window.close();

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
  const projectFiles = Object.fromEntries(T.ws.list().map((p) => [p, T.ws.get(p)]));
  T.openPreview('src/main.jsx');
  for (let i = 0; i < 100 && calls.filter((c) => c[0] === 'openPreview').length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const projectPreview = calls.filter((c) => c[0] === 'openPreview').pop()[2];
  assert.match(projectPreview, /src="https:\/\/appassets\.androidplatform\.net\/assets\/www\/vendor\/babel\/babel\.min\.js"/, 'Babel is served as a local app asset rather than inlined');
  assert.match(projectPreview, /src="https:\/\/appassets\.androidplatform\.net\/assets\/www\/vendor\/react-runtime\/react\.production\.min\.js"/, 'React is served as a local app asset');
  assert.match(projectPreview, /src="https:\/\/appassets\.androidplatform\.net\/assets\/www\/vendor\/react-runtime\/react-dom\.production\.min\.js"/, 'ReactDOM is served as a local app asset');
  const hugeHtml = w.ProjectPreview.projectHtml('src/main.jsx', projectFiles, { testMode: true, vendorSources: { babel: 'x'.repeat(2400000), react: 'y'.repeat(150000), reactDom: 'z'.repeat(150000) } });
  assert.ok(hugeHtml.length < 100000, 'multi-megabyte vendor source is never inlined into the WebView HTML/Java bridge payload');
  assert.doesNotMatch(projectPreview, /unpkg\.com\/@babel/, 'preview does not fetch Babel from a CDN');
  assert.match(projectPreview, /type="importmap"/, 'module import map is injected');
  const importMap = JSON.parse(projectPreview.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  assert.ok(importMap.imports.react.startsWith('data:text/javascript'), 'React resolves to its in-memory offline runtime');
  assert.ok(importMap.imports['react-native'].startsWith('data:text/javascript'), 'react-native resolves to an in-memory shim');
  assert.strictEqual(importMap.imports['react-native-web'], importMap.imports['react-native'], 'react-native-web has the same offline primitive fallback');
  const nativeShim = decodeURIComponent(importMap.imports['react-native'].split(',').slice(1).join(','));
  ['View', 'Text', 'Pressable', 'TouchableOpacity', 'TextInput', 'ScrollView', 'FlatList', 'StyleSheet', 'SafeAreaView', 'AppRegistry'].forEach((name) => assert.ok(nativeShim.includes(name), 'RN shim exports ' + name));
  const priorGlobals = { React: globalThis.React, ReactDOM: globalThis.ReactDOM, window: globalThis.window, document: globalThis.document };
  try {
    globalThis.React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }) };
    globalThis.ReactDOM = { createRoot: () => ({ render() {} }) };
    globalThis.window = { innerWidth: 360, innerHeight: 640, devicePixelRatio: 1 };
    globalThis.document = { getElementById: () => null };
    const reactFixture = 'data:text/javascript,' + encodeURIComponent('export default globalThis.React');
    const runnableShim = nativeShim.replace("from 'react'", 'from "' + reactFixture + '"');
    const shimModule = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(runnableShim));
    const nativeTree = shimModule.View({ children: shimModule.Text({ children: 'offline' }) });
    assert.strictEqual(nativeTree.type, 'div', 'offline RN shim module loads and creates browser primitives');
    assert.strictEqual(shimModule.StyleSheet.flatten([{ padding: 2 }, { margin: 1 }]).padding, 2, 'RN style arrays flatten offline');
  } finally {
    ['React', 'ReactDOM', 'window', 'document'].forEach((k) => { if (priorGlobals[k] === undefined) delete globalThis[k]; else globalThis[k] = priorGlobals[k]; });
  }
  assert.match(projectPreview, /react-dom\/client/, 'React DOM client is mapped');
  assert.match(projectPreview, /"entry":"src\/main.jsx"/, 'project entry is chosen');
  assert.match(projectPreview, /"apiPath":"backend\/server.js"/, 'Express entry is identified');
  assert.ok(projectPreview.includes('src/App.jsx'), 'multi-file source is embedded');
  assert.match(projectPreview, /cdn\.tailwindcss\.com/, 'Tailwind utility preview is enabled for normal user previews');
  const deterministicTestHtml = w.ProjectPreview.projectHtml('src/main.jsx', projectFiles, { testMode: true });
  assert.doesNotMatch(deterministicTestHtml, /cdn\.tailwindcss\.com/, 'test_webapp skips external Tailwind loads for deterministic offline verification');
  assert.match(deterministicTestHtml, /Tailwind CDN skipped/, 'test run clearly reports omitted remote styling');
  assert.match(projectPreview, /__cybPreviewError/, 'runtime errors have an in-preview display');
  assert.match(projectPreview, /Failed to load preview asset/, 'failed bundled runtime requests are visible in preview diagnostics');
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
