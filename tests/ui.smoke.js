// UI smoke test in jsdom with a fake streaming model. Run: NODE_PATH=<dir with jsdom> node tests/ui.smoke.js
const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');

const sse = (text) => text.match(/[\s\S]{1,7}/g).map((t) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
const replies = [
  'I will build it.\n<write_file path="index.html">\n<!doctype html>\n<link rel="stylesheet" href="s.css">\n<h1>Timer</h1>\n<script src="app.js"></script>\n</write_file>\n<write_file path="s.css">\nh1{color:red}\n</write_file>\n<write_file path="app.js">\nconsole.log("hi")\n</write_file>',
  '<edit_file path="s.css">\n<search>red</search>\n<replace>green</replace>\n</edit_file>',
  'Done. **Three files** created.\n```js\nlet a = 1;\n```',
];
const requests = [];

(async () => {
  const errors = [];
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = {}; // jsdom has no localStorage on file:// origins
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.addEventListener('error', (e) => errors.push(e.message));
      w.confirm = () => true;
      w.fetch = async (url, opt) => {
        requests.push({ url, body: opt.body && JSON.parse(opt.body), headers: opt.headers });
        if (/\/models$/.test(url)) return { status: 200, headers: { get: () => 'application/json' }, body: stream(JSON.stringify([{ name: 'openai' }, { name: 'qwen-coder' }])) };
        if (requests.filter((r) => r.body).length > replies.length) return { status: 401, headers: { get: () => '' }, body: stream('{"error":{"message":"slow down"}}') };
        return { status: 200, headers: { get: () => 'text/event-stream' }, body: stream(sse(replies[requests.filter((r) => r.body).length - 1])) };
      };
      function stream(s) { const chunks = Buffer.from(s).toString().match(/[\s\S]{1,23}/g).map((c) => new TextEncoder().encode(c)); return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) }; }
    },
  });
  const w = dom.window, d = w.document;
  await new Promise((r) => setTimeout(r, 600));
  assert.deepStrictEqual(errors, []);
  assert.ok(d.querySelector('.welcome'), 'welcome screen');
  assert.strictEqual(d.querySelectorAll('#agents .pill').length, 5);
  assert.ok(/^openai/.test(d.getElementById('btnModel').textContent));
  assert.ok(d.getElementById('modeBtn') && /Coder/.test(d.getElementById('btnMode').textContent), 'mode selector');

  d.getElementById('input').value = 'Build a timer';
  d.getElementById('btnSend').click();
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepStrictEqual(errors, []);
  const chat = requests.filter((r) => r.body);
  assert.strictEqual(chat.length, 3, 'agent loop made 3 model calls');
  assert.strictEqual(chat[0].url, 'https://text.pollinations.ai/openai');
  assert.ok(chat[0].body.messages[0].role === 'system' && /<write_file/.test(chat[0].body.messages[0].content));
  assert.ok(/<tool_results>[\s\S]*Created index\.html/.test(chat[1].body.messages.at(-1).content));
  assert.ok(/Applied 1 edit to s\.css/.test(chat[2].body.messages.at(-1).content));
  assert.ok(/s\.css/.test(chat[2].body.messages[0].content), 'workspace listing is in the system prompt');
  assert.strictEqual(d.querySelectorAll('.msg.assistant').length, 3);
  assert.strictEqual(d.querySelectorAll('.msg.tool').length, 2);
  assert.strictEqual(d.querySelectorAll('.msg.error').length, 0);
  assert.ok(d.querySelector('.msg.assistant pre code'), 'code block rendered');
  assert.ok(!/<write_file/.test(d.getElementById('messages').textContent.replace(/\[write_file[^\]]*\]/g, '')), 'raw tool tags are hidden');
  assert.strictEqual(d.getElementById('fileBadge').textContent, '3');

  // files sheet → open html → run preview with inlined assets
  d.getElementById('btnFiles').click();
  const rows = [...d.querySelectorAll('#sheetBody .file')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.fn').textContent), ['app.js', 'index.html', 's.css']);
  rows[1].click();
  assert.ok(/Timer/.test(d.querySelector('.editor').value));
  [...d.querySelectorAll('#sheetActions button')].find((b) => /Run/.test(b.textContent)).click();
  const src = d.querySelector('iframe.preview').srcdoc;
  assert.ok(/<style>\s*h1\{color:green\}/.test(src) && /console\.log\("hi"\)/.test(src) && !/href="s\.css"/.test(src), src);
  assert.ok(w.onNativeBack() && w.onNativeBack() && w.onNativeBack() && !w.onNativeBack(), 'back closes sheets one by one');

  // model picker loads list
  d.getElementById('btnModel').click();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok([...d.querySelectorAll('.model')].some((m) => m.textContent === 'qwen-coder'));
  [...d.querySelectorAll('.model')].find((m) => m.textContent === 'qwen-coder').click();
  assert.ok(/qwen-coder/.test(d.getElementById('btnModel').textContent));

  // provider error is shown clearly
  d.getElementById('input').value = 'again';
  d.getElementById('btnSend').click();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(/refused the request[\s\S]*slow down/i.test(d.querySelector('.msg.error').textContent), d.querySelector('.msg.error').textContent);
  assert.strictEqual(requests.at(-1).body.model, 'qwen-coder');

  // key-required provider without key
  d.getElementById('btnModel').click();
  [...d.querySelectorAll('.tabs .pill')].find((b) => b.textContent === 'Groq').click();
  d.querySelector('.model').click();
  d.getElementById('input').value = 'hi'; d.getElementById('btnSend').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(/Add your free Groq key/.test([...d.querySelectorAll('.msg.error')].at(-1).textContent));

  // settings sheet renders, persistence survived
  d.getElementById('dSettings').click();
  assert.strictEqual(d.querySelectorAll('#sheetBody .srow').length, 9);
  [...d.querySelectorAll('#sheetBody .srow')].find((b) => /Model Providers/.test(b.textContent)).click();
  assert.strictEqual(d.querySelectorAll('#sheetBody .card').length, Object.keys(w.__cyb.C.PROVIDERS).length);
  w.onNativeBack();
  [...d.querySelectorAll('#sheetBody .srow')].find((b) => /Appearance/.test(b.textContent)).click();
  [...d.querySelectorAll('#sheetBody .model')].find((b) => b.textContent === 'Light').click();
  assert.strictEqual(d.documentElement.dataset.theme, 'light');
  [...d.querySelectorAll('#sheetBody .model')].find((b) => b.textContent === 'Dark').click();
  w.onNativeBack(); w.onNativeBack();
  w.onNativeBack(); d.getElementById('dGit').click();
  assert.ok(/Access token/.test(d.getElementById('sheetBody').textContent));
  assert.ok(JSON.parse(w.localStorage.getItem('cyb.sessions'))[0].messages.length >= 6);
  assert.deepStrictEqual(errors, []);
  console.log('UI SMOKE TEST PASSED');
  w.close();
})().catch((e) => { console.error(e && (e.stack || e.message || e)); process.exit(1); });
