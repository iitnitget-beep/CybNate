// End-to-end test in real headless Chromium with a scripted model.
// Needs: npm i puppeteer-core @sparticuz/chromium, and the www folder served at $APP_URL (default http://localhost:8080).
const assert = require('assert');
const fs = require('fs');
const chromium = require('@sparticuz/chromium').default || require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const URL0 = process.env.APP_URL || 'http://localhost:8080/index.html';
const shots = process.env.SHOTS || '/tmp/shots';

const replies = [
  // 1: plan, write code with a bug, run the tests
  'I\'ll build it.\n<write_todos>\n- [ ] Write calc.py\n- [ ] Write tests\n- [ ] Run tests\n</write_todos>\n' +
  '<write_file path="calc.py">\ndef add(a, b):\n    return a - b\n\ndef mean(xs):\n    return sum(xs) / len(xs)\n</write_file>\n' +
  '<write_file path="test_calc.py">\nimport unittest\nfrom calc import add, mean\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_mean(self):\n        self.assertEqual(mean([1, 2, 3]), 2)\n\nif __name__ == "__main__":\n    unittest.main()\n</write_file>\n' +
  '<run_terminal_command>\npython -m unittest -v\n</run_terminal_command>',
  // 2: fix and re-run, plus a JS command
  'The add test fails. Fixing.\n<edit_file path="calc.py">\n<search>    return a - b</search>\n<replace>    return a + b</replace>\n</edit_file>\n' +
  '<run_terminal_command>python -m unittest -v</run_terminal_command>\n<write_file path="hi.js">\nconst fs = require("fs");\nfs.writeFileSync("out.json", JSON.stringify({ lines: fs.readFileSync("calc.py", "utf8").split("\\n").length }));\nconsole.log("wrote out.json");\n</write_file>\n<run_terminal_command>node hi.js</run_terminal_command>',
  // 3: delegate a review
  '<write_todos>\n- [x] Write calc.py\n- [x] Write tests\n- [x] Run tests\n</write_todos>\n<spawn_agent type="reviewer">\nReview calc.py and test_calc.py for bugs.\n</spawn_agent>',
  // 4: (sub-agent) reads then reports
  '<read_file path="calc.py"/>',
  'mean() raises ZeroDivisionError on an empty list.',
  // 6: final
  'Done. Tests pass (2/2); the reviewer noted `mean([])` raises.\n<suggest_followups>\nHandle empty lists in mean()\nAdd a CLI\n</suggest_followups>',
];

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: 'shell' });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  await page.evaluateOnNewDocument((replies) => {
    window.__calls = [];
    const real = window.fetch.bind(window);
    window.fetch = async (url, opt) => {
      if (!/pollinations/.test(String(url))) return real(url, opt);
      if (/\/models$/.test(url)) return new Response(JSON.stringify([{ name: 'openai' }]), { headers: { 'content-type': 'application/json' } });
      const body = JSON.parse(opt.body); window.__calls.push(body);
      const text = replies[window.__calls.length - 1] || 'no more replies';
      const sse = text.match(/[\s\S]{1,40}/g).map((t) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    };
  }, replies);
  await page.goto(URL0, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: shots + '/1-welcome.png' });

  await page.type('#input', 'Build a small calc module with tests and run them');
  await page.click('#btnSend');
  await page.waitForFunction(() => window.__calls.length >= 6 && !document.querySelector('#btnSend.stop'), { timeout: 150000 });
  const calls = await page.evaluate(() => window.__calls);
  const lastUser = (i) => calls[i].messages[calls[i].messages.length - 1].content;

  // real Python ran the real tests: first failing, then passing
  assert.ok(/FAIL: test_add[\s\S]*AssertionError: -1 != 5[\s\S]*FAILED \(failures=1\)[\s\S]*\[exit code 1\]/.test(lastUser(1)), lastUser(1));
  assert.ok(/Applied 1 edit to calc\.py[\s\S]*Ran 2 tests[\s\S]*OK[\s\S]*\[exit code 0\]/.test(lastUser(2)), lastUser(2));
  assert.ok(/wrote out\.json[\s\S]*\[exit code 0\][\s\S]*files changed: out\.json/.test(lastUser(2)), lastUser(2));
  // sub-agent got its own context and prompt, and its report came back to the orchestrator
  assert.ok(/strict senior code reviewer/.test(calls[3].messages[0].content) && !/spawn_agent/.test(calls[3].messages[0].content));
  assert.strictEqual(calls[3].messages.length, 2);
  assert.ok(/def add\(a, b\):\n    return a \+ b/.test(lastUser(4)), 'sub-agent read the fixed file');
  assert.ok(/\[agent reviewer\]\nmean\(\) raises ZeroDivisionError/.test(lastUser(5)), lastUser(5));
  assert.ok(/# Environment[\s\S]*CPython/.test(calls[0].messages[0].content));

  const ui = await page.evaluate(() => ({
    files: window.__cyb.ws.list(), json: window.__cyb.ws.get('out.json'),
    chips: [...document.querySelectorAll('.followups .sugg')].map((b) => b.textContent),
    raw: /<(write_file|run_terminal_command|spawn_agent|suggest_followups)/.test(document.querySelector('#messages').innerText.replace(/\[[^\]]*\]/g, '')),
    tasks: document.querySelector('#messages').innerText.includes('✅ Run tests'),
    errors: document.querySelectorAll('.msg.error').length,
  }));
  assert.deepStrictEqual(ui.files, ['calc.py', 'hi.js', 'out.json', 'test_calc.py']);
  assert.strictEqual(ui.json, '{"lines":5}');
  assert.deepStrictEqual(ui.chips, ['↳ Handle empty lists in mean()', '↳ Add a CLI']);
  assert.ok(!ui.raw && ui.tasks && ui.errors === 0, JSON.stringify(ui));
  await page.screenshot({ path: shots + '/2-chat.png' });
  await page.evaluate(() => { document.querySelector('#messages').scrollTop = 0; document.querySelectorAll('.msg.tool details')[0].open = true; });
  await page.screenshot({ path: shots + '/3-chat-top.png' });

  // direct runtime checks
  const rt = await page.evaluate(async () => {
    const T = window.__cyb, o = {};
    o.err = await T.runCommand('python -c "import sys; sys.exit(3)"', 60);
    T.ws.set('pkg/__init__.py', ''); T.ws.set('pkg/m.py', 'V = 1\n'); T.ws.set('use.py', 'from pkg.m import V\nimport sys\nprint("V", V, sys.argv[1:])\n');
    o.a = await T.runCommand('python use.py x y', 60);
    T.ws.set('pkg/m.py', 'V = 2\n');
    o.b = await T.runCommand('python use.py', 60);
    o.cd = await T.runCommand('cd pkg && python -c "import os; print(sorted(os.listdir(\'.\')))"', 60);
    const t = Date.now(); o.loop = await T.runCommand('python -c "while True: pass"', 2); o.loopMs = Date.now() - t;
    o.after = await T.runCommand('python -c "print(6*7)"', 120);
    T.ws.set('bad.js', 'function (');
    o.check = await T.runCommand('node --check bad.js', 20);
    o.async = await T.runCommand('node -e "setTimeout(() => console.log(\'later\'), 50); Promise.resolve().then(() => console.log(\'micro\')); process.stdout.write(\'now \')"', 20);
    o.jsloop = await T.runCommand('node -e "for(;;){}"', 2);
    o.exit = await T.runCommand('node -e "console.log(1); process.exit(4); console.log(2)"', 20);
    o.sh = await T.runCommand('ls -la', 20);
    o.npm = await T.runCommand('npm test', 20);
    o.search = T.parseSearchResults('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpyodide.org%2Fen%2Fstable%2F&rut=x">Pyodide <b>docs</b></a><a class="result__snippet">Python in the browser</a></div>');
    o.text = T.htmlToText('<html><head><title>T</title><script>x()</script></head><body><nav>menu</nav><main><h1>Head</h1><p>Hello <a href="https://a.b/c">link text</a></p><pre>code\n  x</pre><ul><li>one</li></ul></main></body></html>', 'https://e.x');
    return o;
  });
  assert.strictEqual(rt.err.code, 3);
  assert.ok(/V 1 \['x', 'y'\]/.test(rt.a.out), rt.a.out);
  assert.ok(/V 2 \[\]/.test(rt.b.out), 'edited module is reloaded: ' + rt.b.out);
  assert.ok(/\['__init__\.py', 'm\.py'\]/.test(rt.cd.out), rt.cd.out);
  assert.ok(rt.loop.timedOut && rt.loopMs < 8000, JSON.stringify(rt.loop) + rt.loopMs);
  assert.ok(/42/.test(rt.after.out), 'python recovers after a kill: ' + rt.after.out);
  assert.ok(rt.check.code === 1 && /SyntaxError|Unexpected/.test(rt.check.out), JSON.stringify(rt.check));
  assert.ok(/now micro\nlater/.test(rt.async.out), JSON.stringify(rt.async.out));
  assert.ok(rt.jsloop.timedOut);
  assert.ok(rt.exit.code === 4 && rt.exit.out.trim() === '1', JSON.stringify(rt.exit));
  assert.ok(rt.sh.code === 127 && /installed Android app/.test(rt.sh.out));
  assert.ok(rt.npm.code === 127 && /not available/.test(rt.npm.out));
  assert.deepStrictEqual(rt.search, [{ title: 'Pyodide docs', url: 'https://pyodide.org/en/stable/', snippet: 'Python in the browser' }]);
  assert.ok(/^# T\nhttps:\/\/e\.x\n\n# Head\n\nHello link text \(https:\/\/a\.b\/c\)\n\n```\ncode\n  x\n```\n\n- one$/.test(rt.text) && !/menu|x\(\)/.test(rt.text), JSON.stringify(rt.text));

  // screens
  await page.click('#btnTerm');
  await page.type('.termrow input', 'python -c "print(sum(range(101)))"'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /5050/.test(document.querySelector('.term').textContent), { timeout: 60000 });
  await page.screenshot({ path: shots + '/4-terminal.png' });
  await page.click('#sheetBack'); await page.click('#btnMenu'); await page.screenshot({ path: shots + '/5-drawer.png' });
  await page.click('#dGit'); await page.screenshot({ path: shots + '/6-github.png' });
  await page.click('#sheetBack'); await page.click('#btnFiles'); await page.screenshot({ path: shots + '/7-files.png' });
  assert.deepStrictEqual(errors, []);
  console.log('BROWSER E2E TEST PASSED');
  await browser.close();
})().catch((e) => { console.error(e && (e.stack || e)); process.exit(1); });
