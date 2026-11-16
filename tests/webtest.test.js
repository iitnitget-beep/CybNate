// test_webapp harness, run for real in jsdom (scripts enabled). jsdom has no layout engine, so the layout checks are covered on the device self test.
const assert = require('assert');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('SKIPPED: jsdom is not installed (NODE_PATH=/tmp/v/node_modules)'); process.exit(0); }
const W = require('../app/src/main/assets/www/webtest.js');
function load(html, script, wait) {
  return new Promise((resolve) => {
    const dom = new JSDOM(W.instrument(html, script, wait == null ? 30 : wait, 'id1'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: new (require('jsdom').VirtualConsole)() });
    const t = setInterval(() => { if (dom.window.__cybResult) { clearInterval(t); const r = dom.window.__cybResult; dom.window.close(); resolve(r); } }, 20);
  });
}
const PAGE = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>Todo</title></head><body>
<h1>Todos</h1><form id="f"><input id="new" placeholder="task"><button id="add" type="submit">Add</button></form><ul id="list"></ul><span id="count">0 items</span>
<script>
const items = [];
function render() { document.getElementById('list').innerHTML = items.map((t) => '<li>' + t + '</li>').join(''); document.getElementById('count').textContent = items.length + ' items'; }
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); const i = document.getElementById('new'); if (i.value.trim()) { items.push(i.value.trim()); i.value = ''; render(); console.log('added', items.length); } });
console.log('ready');
</script></body></html>`;
(async () => {
  // harness goes right after <head>, so the doctype stays first (no quirks mode)
  assert.ok(/^<!DOCTYPE html><html><head><script>\(function harness/.test(W.instrument(PAGE, '', 0, 'x')));
  assert.ok(W.instrument('<p>hi</p>', 'x</script><b>', 0, 'x').indexOf('x</script><b>') < 0, 'a test script cannot break out of the harness tag');

  let r = W.format(await load(PAGE), 'index.html');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/Title: Todo/.test(r.out) && /Runtime errors: none/.test(r.out) && /\[log\] ready/.test(r.out) && /Test script: none given/.test(r.out) && /Todos/.test(r.out), r.out);

  // a test script that drives the page
  r = W.format(await load(PAGE, `type('#new', 'buy milk'); click('#add'); type('#new', 'walk'); click('#add');
    assert($$('#list li').length === 2, 'two items'); assert(text('#count') === '2 items', 'counter shows ' + text('#count')); return $$('#list li').map((l) => l.textContent).join('|');`), 'index.html');
  assert.strictEqual(r.code, 0, r.out); assert.ok(/Test script: PASSED \(returned buy milk\|walk\)/.test(r.out) && /\[log\] added 2/.test(r.out), r.out);

  // a failing assertion, a missing element, a syntax error and an async wait
  r = W.format(await load(PAGE, `click('#add'); assert($$('#list li').length === 1, 'empty input must not add... expected 1')`), 'index.html');
  assert.strictEqual(r.code, 1); assert.ok(/Test script: FAILED: Assertion failed: empty input/.test(r.out), r.out);
  r = W.format(await load(PAGE, `click('#nope')`), 'index.html'); assert.ok(/FAILED: No element matches #nope/.test(r.out), r.out);
  r = W.format(await load(PAGE, `this is not js`), 'index.html'); assert.ok(/FAILED: The test script has a syntax error/.test(r.out), r.out);
  r = W.format(await load('<html><head></head><body><div id="a"></div><script>setTimeout(() => { document.getElementById("a").innerHTML = "<b id=late>late</b>"; }, 120);</script></body></html>', `await waitFor('#late'); return text('#late')`), 'a.html');
  assert.strictEqual(r.code, 0, r.out); assert.ok(/PASSED \(returned late\)/.test(r.out) && /No <meta name="viewport">/.test(r.out), r.out);

  // runtime errors are caught and fail the run, even without a test script (jsdom has no unhandledrejection event: that path is checked in the device self test)
  r = W.format(await load('<html><head><title>Bad</title></head><body><p>x</p><script>console.error("boom", {a: 1}); undefinedFunction();</script></body></html>', '', 60), 'bad.html');
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/undefinedFunction is not defined/.test(r.out) && /\[error\] boom \{"a":1\}/.test(r.out), r.out);
  r = W.format(await load('<html><head></head><body></body></html>'), 'empty.html'); assert.ok(/The page shows nothing/.test(r.out), r.out);
  assert.strictEqual(W.format(null, 'x.html').code, 1); assert.strictEqual(W.format('not json', 'x.html').code, 1);
  console.log('ALL WEBTEST TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
