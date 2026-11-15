// Auto mode in jsdom with fake models: routing chip, pipeline, different reviewer model, fallback, budget cap,
// ask limits, helper write rules and one-at-a-time approvals. Run: NODE_PATH=<dir with jsdom> node tests/auto.test.js
const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const MODELS = ['qwen/qwen3-coder:free', 'deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-20b:free'];
const sse = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
const roleOf = (sys) => (/You route a request/.test(sys) ? 'router' : /CybNate Planner/.test(sys) ? 'planner' : /CybNate Reviewer/.test(sys) ? 'reviewer' : /CybNate Reverse/.test(sys) ? 'reverse'
  : /codebase explorer/.test(sys) ? 'explorer' : /deep-thinking/.test(sys) ? 'thinker' : /expert AI coding agent/.test(sys) ? 'coder' : 'chat');

async function boot() {
  const calls = []; const script = { reply: () => 'ok', fail: () => false };
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify({ provider: 'openrouter', model: MODELS[0], keys: { openrouter: 'sk-test' }, models: { openrouter: MODELS }, nativeTools: false }) };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.confirm = () => true;
      const stream = (s) => { const chunks = [new TextEncoder().encode(s)]; return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) }; };
      w.fetch = async (url, opt) => {
        const body = opt && opt.body ? JSON.parse(opt.body) : null;
        if (!body) return { status: 200, headers: { get: () => 'application/json' }, body: stream('[]') };
        const sys = body.messages[0].content, c = { role: roleOf(sys), model: body.model, provider: /openrouter/.test(url) ? 'openrouter' : 'pollinations', messages: body.messages };
        calls.push(c);
        await new Promise((r) => setTimeout(r, 15));
        if (script.fail(c)) return { status: 500, headers: { get: () => 'application/json' }, body: stream('{"error":{"message":"upstream exploded"}}') };
        return { status: 200, headers: { get: () => 'text/event-stream' }, body: stream(sse(script.reply(c, calls))) };
      };
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T, 'app started');
  ['openrouter', 'pollinations'].forEach((p) => { T.limiter.limits[p] = { concurrent: 2, rpm: 6000, daily: 0 }; });
  const stats = { sheets: 0, maxSheets: 0 };
  /** Send a message, press Allow on every approval sheet, wait until the run ends. */
  const say = async (text, answer) => {
    calls.length = 0; d.getElementById('input').value = text; d.getElementById('btnSend').click();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const n = d.querySelectorAll('.approval').length; stats.maxSheets = Math.max(stats.maxSheets, n);
      const btn = d.querySelector('.approval .abtn.' + (answer || 'allow')); if (btn) { stats.sheets++; btn.click(); }
      if (!d.querySelector('#btnSend.stop') && i > 2) break;
    }
    assert.ok(!d.querySelector('#btnSend.stop'), 'run finished: ' + text);
    const tl = [...d.querySelectorAll('.msg.timeline')].pop();
    return { tl, chip: tl ? tl.querySelector('.routechip').textContent : '', rows: tl ? [...tl.querySelectorAll('.tlrow')].map((x) => x.textContent) : [], reqs: tl ? tl.querySelector('.reqs').textContent : '',
      errors: [...d.querySelectorAll('.msg.error')].map((x) => x.textContent) };
  };
  const fresh = () => { d.getElementById('btnNew') ? d.getElementById('btnNew').click() : null; };
  return { w, d, T, calls, script, say, stats, fresh };
}

(async () => {
  const { w, d, T, calls, script, say, stats } = await boot();
  const fam = T.C.Orchestra.familyOf, has = (rows, re) => rows.some((x) => re.test(x));
  const newChat = () => d.getElementById('btnNew').click();
  assert.ok(/Auto/.test(d.getElementById('btnMode').textContent), 'Auto is the default agent');

  // 1. routing by rules, no router call
  T.ws.set('app.apk', new w.Uint8Array([80, 75, 3, 4]));
  script.reply = () => 'This is an APK. Nothing else to do.';
  let r = await say('Analyse the APK I imported: permissions, libraries, URLs');
  assert.ok(/^Auto → Reverse/.test(r.chip), r.chip); assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].role, 'reverse');
  assert.strictEqual(r.reqs, 'requests used: 1/30'); T.ws.remove('app.apk');
  newChat(); r = await say('Explain closures with a small example');
  assert.ok(/^Auto → Chat/.test(r.chip) && calls.length === 1 && calls[0].role === 'chat', r.chip);
  newChat(); r = await say('Plan a notes app with tags and search');
  assert.ok(/^Auto → Planner/.test(r.chip) && calls[0].role === 'planner' && /r1/.test(calls[0].model), 'planner on a reasoning model: ' + calls[0].model);

  // 2. small task: Coder → Reviewer (other family) → Coder fix → proof run
  newChat(); T.ws.set('calc.py', 'def add(a, b):\n    return a - b\n');
  script.reply = (c, all) => {
    const n = all.filter((x) => x.role === c.role).length;
    if (c.role === 'reviewer') return 'Bug: calc.py has no test. Add test_calc.py that checks add(2, 3) == 5.';
    if (n === 1) return '<edit_file path="calc.py">\n<search>a - b</search>\n<replace>a + b</replace>\n</edit_file>';
    if (n === 2) return 'Fixed the operator.';
    if (n === 3) return '<write_file path="test_calc.py">\nfrom calc import add\nassert add(2, 3) == 5\n</write_file>\n<run_terminal_command>\npython test_calc.py\n</run_terminal_command>';
    return 'Done. The test was run.';
  };
  r = await say('fix the bug in calc.py');
  assert.ok(/^Auto → Coder/.test(r.chip), r.chip);
  assert.deepStrictEqual(calls.map((c) => c.role), ['coder', 'coder', 'reviewer', 'coder', 'coder'], 'no planner for a small task, one review round');
  const rev = calls.find((c) => c.role === 'reviewer'), cod = calls.find((c) => c.role === 'coder');
  assert.strictEqual(cod.model, 'qwen/qwen3-coder:free'); assert.notStrictEqual(fam(rev.model), fam(cod.model), 'reviewer model from another family: ' + rev.model);
  assert.ok(/<untrusted_data source="reviewer agent">\nBug: calc\.py/.test(calls[3].messages[calls[3].messages.length - 1].content), 'review reaches the coder as untrusted data');
  assert.ok(has(r.rows, /Coder.*qwen3-coder/) && has(r.rows, /Reviewer/) && has(r.rows, /Coder fix/) && has(r.rows, /Proof.*\$ python test_calc\.py/), r.rows.join(' | '));
  assert.strictEqual(r.reqs, 'requests used: 5/30'); assert.strictEqual(T.ws.get('calc.py'), 'def add(a, b):\n    return a + b\n');
  assert.ok(stats.sheets >= 2 && stats.maxSheets === 1, 'approvals were asked, one sheet at a time');
  assert.ok(/Coder ✓ → Reviewer ✓ → Coder fix ✓/.test(r.tl.querySelector('summary').textContent), r.tl.querySelector('summary').textContent);

  // 3. big task: Planner first; no file changes, so the review is skipped
  newChat(); script.reply = (c) => (c.role === 'planner' ? '1. Create app.py\n2. Add login' : 'I need more details before writing code.');
  r = await say('Build a complete inventory management system with login, reports and an admin dashboard');
  assert.deepStrictEqual(calls.map((c) => c.role), ['planner', 'coder']);
  assert.ok(/<untrusted_data source="planner agent">\n1\. Create app\.py/.test(calls[1].messages[1].content) && calls[1].messages.length === 2, 'plan handed to the coder as untrusted data in one user turn');
  assert.ok(has(r.rows, /Planner.*deepseek-r1/) && has(r.rows, /Reviewer.*no file changes/), r.rows.join(' | '));

  // 4. fallback: the coder's model fails, the next one in the chain answers
  newChat(); script.fail = (c) => c.model === 'qwen/qwen3-coder:free'; script.reply = () => 'Nothing to change.';
  r = await say('fix the typo in calc.py');
  assert.ok(calls.length >= 2 && calls[calls.length - 1].model !== 'qwen/qwen3-coder:free', 'second model used');
  assert.ok(has(r.rows, /fallback from qwen\/qwen3-coder:free/), r.rows.join(' | ')); assert.strictEqual(r.errors.length, 0);
  assert.ok(T.health['openrouter|qwen/qwen3-coder:free'].fail >= 1, 'failure recorded for the health ranking');
  script.fail = () => false;

  // 5. task budget: the run stops at the cap and reports
  newChat(); T.settings.taskBudget = 3; script.reply = () => '<list_files/>';
  r = await say('fix the bug in calc.py');
  assert.strictEqual(calls.length, 3, 'exactly 3 requests were sent'); assert.strictEqual(r.reqs, 'requests used: 3/3');
  assert.ok(r.errors.some((e) => /request budget for this task is used up \(3\/3\)/.test(e) && /Files changed so far: none/.test(e) && /Steps: Coder/.test(e)), r.errors.join(' | '));
  T.settings.taskBudget = 30;

  // 6. ask_agent: max 3 per task, helpers run in parallel behind the limiter, write rules, approvals one at a time
  newChat(); stats.sheets = 0; stats.maxSheets = 0; let k = 0;
  script.reply = (c, all) => {
    const again = /<tool_results>/.test(c.messages[c.messages.length - 1].content);
    if (c.role === 'reverse') return again ? 'Notes written.' : '<write_file path="analysis/n' + (++k) + '.md">\nnotes\n</write_file>\n<write_file path="calc.py">\nHACKED\n</write_file>';
    if (c.role === 'reviewer') return 'LGTM';
    if (c.role === 'coder' && !again) return '<ask_agent type="reverse">\nwrite notes\n</ask_agent>\n<ask_agent type="reverse">\nwrite more notes\n</ask_agent>\n<ask_agent type="explorer">\nlook around\n</ask_agent>\n<ask_agent type="thinker">\nthink\n</ask_agent>';
    return c.role === 'coder' ? 'All done.' : 'report';
  };
  r = await say('refactor calc.py please');
  assert.ok(T.ws.has('analysis/n1.md') && T.ws.has('analysis/n2.md'), 'reverse helpers wrote inside analysis/');
  assert.strictEqual(T.ws.get('calc.py'), 'def add(a, b):\n    return a + b\n', 'a helper could not overwrite project code');
  assert.ok(stats.sheets >= 2 && stats.maxSheets === 1, 'two helpers asked at the same time, sheets came one by one: ' + stats.sheets + '/' + stats.maxSheets);
  assert.ok(T.limiter.status('openrouter').peak <= 2, 'never more than 2 requests at once');
  const back = calls.filter((c) => c.role === 'coder')[1].messages.pop().content;
  assert.ok(/ask limit reached: 3 helper agents per task/.test(back), 'fourth ask refused');
  assert.ok(/<untrusted_data source="agent reverse">/.test(back) && /may write only inside the analysis\/ folder/.test(calls.filter((c) => c.role === 'reverse').pop().messages.pop().content));
  assert.ok(!calls.some((c) => c.role === 'thinker') && calls.filter((c) => c.role === 'explorer').length === 1);
  assert.ok(has(r.rows, /↳ Reverse/) && has(r.rows, /Reviewer/) && has(r.rows, /Coder fix.*review passed/), r.rows.join(' | '));

  // 7. unclear request: one small router call; the chip lets the user override
  newChat(); script.reply = (c) => (c.role === 'router' ? 'chat' : 'A pomodoro is a 25 minute timer.');
  r = await say('pomodoro');
  assert.deepStrictEqual(calls.map((c) => c.role), ['router', 'chat']); assert.ok(/^Auto → Chat/.test(r.chip) && has(r.rows, /Router/), r.chip);
  assert.ok(/gpt-oss-20b/.test(calls[0].model), 'router uses a small fast model: ' + calls[0].model);
  calls.length = 0; r.tl.querySelector('.routechip').click();
  const opt = r.tl.parentNode.querySelector('.routemenu .routeopt[data-agent=planner]'); assert.ok(opt, 'override menu'); opt.click();
  for (let i = 0; i < 200 && (d.querySelector('#btnSend.stop') || !calls.length); i++) await new Promise((x) => setTimeout(x, 25));
  await new Promise((x) => setTimeout(x, 100));
  assert.deepStrictEqual(calls.map((c) => c.role), ['planner'], 'rerun with the chosen agent, no router call');
  assert.ok(/^Planner/.test([...d.querySelectorAll('.routechip')].pop().textContent)); assert.strictEqual(d.querySelectorAll('.msg.user').length, 1, 'the request is not duplicated');

  // 8. low daily budget: single-agent mode (no planner, no reviewer, helpers refused)
  newChat(); T.limiter.limits.openrouter = { concurrent: 2, rpm: 6000, daily: 50 };
  w.localStorage.setItem('cyb.daily', JSON.stringify({ date: new Date().toISOString().slice(0, 10), counts: { openrouter: 45 } }));
  script.reply = (c) => (/<tool_results>/.test(c.messages[c.messages.length - 1].content) ? 'Done.' : '<write_file path="b.py">\nprint(1)\n</write_file>\n<ask_agent type="reviewer">\ncheck\n</ask_agent>');
  r = await say('Build a complete inventory management system with login, reports and an admin dashboard');
  assert.ok(calls.every((c) => c.role === 'coder'), 'only the coder ran: ' + calls.map((c) => c.role));
  assert.ok(/single-agent mode: daily limit nearly used \(4[5-9]\/50\)/.test(r.tl.textContent), r.tl.textContent.slice(0, 200));
  assert.ok(/helper agents are off for this task/.test(calls[1].messages.pop().content));
  // and when the day's limit is gone the run stops with a clear message
  w.localStorage.setItem('cyb.daily', JSON.stringify({ date: new Date().toISOString().slice(0, 10), counts: { openrouter: 50 } }));
  newChat(); r = await say('fix the bug in calc.py');
  assert.ok(calls.length === 0 && r.errors.some((e) => /Daily request limit reached for openrouter/.test(e)), r.errors.join('|'));

  console.log('AUTO MODE TEST PASSED');
  w.close();
})().catch((e) => { console.error(e); process.exit(1); });
