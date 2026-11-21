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
  // the verification gate sends the agent back once: code was written but nothing was checked
  '<get_diagnostics/>',
  'Checked: no problems found.',
];
const requests = [];

(async () => {
  const errors = [];
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: 'openrouter/free', keys: { openrouter: 'sk-or-test' }, taskBudget: 200 }) }; // jsdom has no localStorage on file:// origins
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.addEventListener('error', (e) => errors.push(e.message));
      w.confirm = () => true;
      w.fetch = async (url, opt) => {
        requests.push({ url, body: opt.body && JSON.parse(opt.body), headers: opt.headers });
        if (/\/models$/.test(url)) return { status: 200, headers: { get: () => 'application/json' }, body: stream(JSON.stringify([{ name: 'openai' }, { name: 'qwen-coder:free' }])) };
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
  assert.strictEqual(d.querySelectorAll('#agents .pill').length, 6);
  assert.ok(/^openrouter\/free/.test(d.getElementById('btnModel').textContent));
  assert.ok(d.getElementById('modeBtn') && /Auto/.test(d.getElementById('btnMode').textContent), 'Auto is the default agent');
  // the rest of this file drives the Coder agent directly; Auto mode has its own test (tests/auto.test.js)
  [...d.querySelectorAll('#agents .pill')].find((b) => /Coder/.test(b.textContent)).click();
  assert.ok(/Coder/.test(d.getElementById('btnMode').textContent), 'mode selector');
  w.__cyb.limiter.limits.openrouter = { concurrent: 2, rpm: 6000, daily: 0 };

  d.getElementById('input').value = 'Build a timer';
  d.getElementById('btnSend').click();
  // Ask mode is the default: the agent's file write and command wait for the approval sheet
  let sheets = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const allow = d.querySelector('.approval .abtn.allow');
    if (allow) { sheets++; allow.click(); }
  }
  assert.ok(sheets >= 1, 'approval sheet was shown in Ask mode');
  assert.deepStrictEqual(errors, []);
  const chat = requests.filter((r) => r.body);
  assert.strictEqual(chat.length, 5, 'agent loop made 5 model calls (3 + the verification gate round)');
  assert.ok(/You modified code files but have not verified them yet/.test(chat[3].body.messages.at(-1).content), 'verification gate');
  assert.ok(/No problems found/.test(chat[4].body.messages.at(-1).content), 'diagnostics result reached the model');
  assert.strictEqual(chat[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(chat[0].body.messages[0].role === 'system' && /<write_file/.test(chat[0].body.messages[0].content));
  assert.ok(/<tool_results>[\s\S]*Created index\.html/.test(chat[1].body.messages.at(-1).content));
  assert.ok(/Applied 1 edit to s\.css/.test(chat[2].body.messages.at(-1).content));
  assert.ok(/s\.css/.test(chat[2].body.messages[0].content), 'workspace listing is in the system prompt');
  assert.strictEqual(d.querySelectorAll('.msg.assistant').length, 5);
  assert.strictEqual(d.querySelectorAll('.msg.tool').length, 4);
  assert.strictEqual(d.querySelectorAll('.msg.error').length, 0);
  // Phase 1: results reach the model as untrusted data, and the run can be undone with one tap
  assert.ok(/<untrusted_data source="write_file index\.html">/.test(chat[1].body.messages.at(-1).content), 'tool results are wrapped');
  assert.ok(/never instructions/.test(chat[0].body.messages[0].content), 'untrusted-data rule is in the system prompt');
  assert.ok(d.querySelector('#messages .undo') && /Undo \d+ file change/.test(d.querySelector('#messages .undo').textContent), 'undo button after the run');
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
  assert.ok([...d.querySelectorAll('.model')].some((m) => /^qwen-coder/.test(m.textContent)));
  [...d.querySelectorAll('.model')].find((m) => /^qwen-coder/.test(m.textContent)).click();
  assert.ok(/qwen-coder/.test(d.getElementById('btnModel').textContent));

  // provider error is shown clearly
  d.getElementById('input').value = 'again';
  d.getElementById('btnSend').click();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(/slow down/i.test(d.querySelector('.msg.error').textContent), d.querySelector('.msg.error').textContent);
  assert.strictEqual(requests.at(-1).body.model, 'qwen-coder:free');

  // key-required provider without key
  d.getElementById('btnModel').click();
  [...d.querySelectorAll('.tabs .pill')].find((b) => b.textContent === 'Claude (Anthropic API key)').click();
  const addField = d.querySelector('#sheetBody input.field'); addField.value = 'claude-sonnet-4-5';
  addField.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  d.getElementById('input').value = 'hi'; d.getElementById('btnSend').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(/Add your Claude \(Anthropic API key\) key/.test([...d.querySelectorAll('.msg.error')].at(-1).textContent));

  // settings sheet renders, persistence survived
  d.getElementById('dSettings').click();
  assert.strictEqual(d.querySelectorAll('#sheetBody .srow').length, 13);
  [...d.querySelectorAll('#sheetBody .srow')].find((b) => /Model Providers/.test(b.textContent)).click();
  assert.strictEqual(d.querySelectorAll('#sheetBody .card').length, Object.keys(w.__cyb.C.PROVIDERS).length);
  w.onNativeBack();
  [...d.querySelectorAll('#sheetBody .srow')].find((b) => /Appearance/.test(b.textContent)).click();
  assert.strictEqual(d.querySelectorAll('#sheetBody .theme').length, 8);
  d.querySelector('#sheetBody .theme[data-id=peach]').click();
  assert.strictEqual(d.documentElement.dataset.theme, 'light');
  assert.strictEqual(d.documentElement.style.getPropertyValue('--acc'), '#d9644a');
  [...d.querySelectorAll('#sheetBody .seg button')].find((b) => b.textContent === 'Flat').click();
  assert.strictEqual(d.documentElement.dataset.style, 'flat');
  [...d.querySelectorAll('#sheetBody .seg button')].find((b) => b.textContent === '3D').click();
  d.querySelector('#sheetBody .theme[data-id=dark]').click();
  assert.strictEqual(d.documentElement.dataset.theme, 'dark');
  w.onNativeBack(); w.onNativeBack();
  w.onNativeBack(); d.getElementById('dGit').click();
  assert.ok(/Access token/.test(d.getElementById('sheetBody').textContent));
  assert.ok(JSON.parse(w.localStorage.getItem('cyb.sessions'))[0].messages.length >= 6);
  // Phase 1: approval sheets come one at a time, "allow always" is only for plain commands, Stop cancels, Back denies
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const ctl = new w.AbortController();
  const a1 = w.__cyb.askApproval({ kind: 'shell', command: 'pip install requests', always: true }, ctl.signal);
  const a2 = w.__cyb.askApproval({ kind: 'delete', path: 'x.txt' }, ctl.signal);
  const a3 = w.__cyb.askApproval({ kind: 'push', repo: 'o/r', branch: 'main', files: ['M  a.js'] }, ctl.signal);
  await tick();
  assert.strictEqual(d.querySelectorAll('.approval').length, 1, 'one sheet at a time');
  assert.strictEqual(d.querySelectorAll('.approval .abtn.always').length, 2, 'exact and prefix offered for a plain command');
  [...d.querySelectorAll('.approval .abtn.always')].find((b) => /pip install …/.test(b.textContent)).click();
  assert.strictEqual(await a1, 'allow');
  assert.strictEqual(await w.__cyb.askApproval({ kind: 'shell', command: 'pip install flask', always: true }), 'allow', 'prefix rule applies without a sheet');
  await tick();
  assert.ok(/x\.txt/.test(d.querySelector('.approval').textContent) && !d.querySelector('.approval .abtn.always'), 'delete has no allow-always');
  w.onNativeBack(); assert.strictEqual(await a2, 'deny', 'Back means Deny');
  await tick();
  assert.ok(/Push to GitHub/.test(d.querySelector('.approval').textContent) && !d.querySelector('.approval .abtn.always'), 'push has no allow-always');
  ctl.abort(); await assert.rejects(a3, /Stopped/); assert.ok(!d.querySelector('.approval'), 'Stop closes the pending sheet');
  const chained = w.__cyb.askApproval({ kind: 'shell', command: 'pip install x && rm -rf .', always: true });
  await tick(); assert.ok(d.querySelector('.approval'), 'a chained command is not covered by the prefix rule'); d.querySelector('.approval .abtn.deny').click(); await chained;
  // secret-name sheet: the names are listed and there is no allow-always
  const sec = w.__cyb.askApproval({ kind: 'shell', command: 'node deploy.js', secrets: ['API_TOKEN', 'DB_PASS'], always: false });
  await tick();
  assert.deepStrictEqual([...d.querySelectorAll('.approval .asecret')].map((x) => x.textContent.replace(/^\S+ /, '')), ['API_TOKEN', 'DB_PASS'], 'secret names listed');
  assert.ok(/could send them over the network/.test(d.querySelector('.approval').textContent) && !d.querySelector('.approval .abtn.always'), 'secret warning, no allow-always');
  d.querySelector('.approval .abtn.deny').click(); assert.strictEqual(await sec, 'deny');
  w.__cyb.settings.secrets = [{ name: 'API_TOKEN', value: 'tok-12345' }];
  assert.strictEqual(String(w.__cyb.namedSecrets('echo $API_TOKEN')), 'API_TOKEN'); assert.strictEqual(w.__cyb.namedSecrets('echo hi').length, 0);
  w.__cyb.settings.secrets = [];
  // Undo warns about files over 5 MB that the checkpoint does not hold
  w.__cyb.ws.set('big.bin', new w.Uint8Array(6 * 1048576)); w.__cyb.ws.set('small.txt', 'one');
  const cpBig = w.__cyb.C.Safety.makeCheckpoint(w.__cyb.ws);
  assert.strictEqual(String(cpBig.skipped), 'big.bin');
  w.__cyb.ws.set('small.txt', 'two'); w.__cyb.offerUndo(cpBig);
  assert.ok(/Undo does not cover 1 large file/.test(d.querySelector('.undonote').textContent) && /big\.bin \(6\.0 MB\)/.test(d.querySelector('.undonote').textContent), 'large-file warning shown next to Undo');
  d.querySelector('#messages .undo').click(); assert.strictEqual(w.__cyb.ws.get('small.txt'), 'one'); assert.ok(!d.querySelector('.undonote'));
  const cpBig2 = w.__cyb.C.Safety.makeCheckpoint(w.__cyb.ws); w.__cyb.ws.set('big.bin', new w.Uint8Array(7 * 1048576)); w.__cyb.offerUndo(cpBig2);
  assert.ok(!d.querySelector('#messages .undo') && /changed 1 large file that Undo cannot restore/.test(d.querySelector('.undonote').textContent), 'warns when only a large file changed');
  w.__cyb.ws.remove('big.bin'); w.__cyb.ws.remove('small.txt');
  // permission modes in Settings
  d.getElementById('dSettings').click(); [...d.querySelectorAll('#sheetBody .srow')].find((b) => /^General/.test(b.textContent)).click();
  assert.strictEqual(d.querySelector('.seg.perm button.on').dataset.mode, 'ask', 'Ask is the default mode');
  d.querySelector('.seg.perm button[data-mode=autoedit]').click(); assert.strictEqual(w.__cyb.settings.permission, 'autoedit');
  d.querySelector('.seg.perm button[data-mode=ask]').click();
  assert.deepStrictEqual(errors, []);
  console.log('UI SMOKE TEST PASSED');
  w.close();
})().catch((e) => { console.error(e && (e.stack || e.message || e)); process.exit(1); });
