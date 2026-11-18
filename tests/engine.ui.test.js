// The overhauled agent engine inside the real UI (jsdom, fake models, fake network):
// slash commands, @file, verification gate, stuck-loop warning, tag-less edits, built-in git/npm/curl through the agent, /compact, native-call protocol.
// Run: NODE_PATH=<dir with jsdom> node tests/engine.ui.test.js
const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');
const www = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const sse = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
const roleOf = (sys) => (/You route a request/.test(sys) ? 'router' : /precise working summaries/.test(sys) ? 'summary' : /CybNate Planner/.test(sys) ? 'planner' : /CybNate Reviewer/.test(sys) ? 'reviewer' : /expert AI coding agent|Autonomous Senior Software Engineer/.test(sys) ? 'coder' : 'chat');

async function boot(settings) {
  const calls = [], net = []; const script = { reply: () => 'ok', http: () => null };
  const dom = await JSDOM.fromFile(path.join(www, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      const store = { 'cyb.settings': JSON.stringify(Object.assign({ provider: 'openrouter', model: 'qwen/qwen3-coder:free', keys: { openrouter: 'sk-test' }, models: { openrouter: ['qwen/qwen3-coder:free'] }, nativeTools: false, permMode: 'auto' }, settings || {})) };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
      w.confirm = () => true;
      const stream = (s) => { const chunks = [new TextEncoder().encode(s)]; return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) }; };
      const hdr = (ct) => ({ get: (k) => (/content-type/i.test(k) ? ct : ''), forEach: () => {} });
      w.fetch = async (url, opt) => {
        opt = opt || {};
        if (!/openrouter\.ai|pollinations/.test(url)) { net.push({ url, method: opt.method || 'GET', headers: opt.headers, body: opt.body }); const r = script.http(url, opt) || { status: 404, text: 'not found' }; return { status: r.status, headers: hdr(r.ctype || 'text/plain'), body: stream(r.text) }; }
        const body = opt.body ? JSON.parse(opt.body) : null;
        if (!body) return { status: 200, headers: hdr('application/json'), body: stream('[]') };
        const c = { role: roleOf(body.messages[0].content), model: body.model, messages: body.messages, tools: body.tools }; calls.push(c);
        if (script.never) return new Promise(() => {}); // deliberately ignores AbortSignal to exercise the request deadline
        await new Promise((r) => setTimeout(r, script.delay == null ? 10 : script.delay));
        const rep = script.reply(c, calls);
        if (rep && rep.native) return { status: 200, headers: hdr('application/json'), body: stream(JSON.stringify({ choices: [{ message: { content: '', tool_calls: rep.native } }] })) };
        return { status: 200, headers: hdr('text/event-stream'), body: stream(sse(rep)) };
      };
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 200 && !w.__cyb; i++) await new Promise((r) => setTimeout(r, 50));
  const T = w.__cyb; assert.ok(T, 'app started');
  ['openrouter', 'pollinations'].forEach((p) => { T.limiter.limits[p] = { concurrent: 2, rpm: 6000, daily: 0 }; });
  const pick = (name) => [...d.querySelectorAll('#agents .pill')].find((b) => new RegExp(name).test(b.textContent)).click();
  const say = async (text) => {
    calls.length = 0; d.getElementById('input').value = text; d.getElementById('btnSend').click();
    let request = T.activeRequest;
    for (let i = 0; i < 600; i++) {
      if (T.activeRequest) request = T.activeRequest;
      await new Promise((r) => setTimeout(r, 25));
      const btn = d.querySelector('.approval .abtn.allow'); if (btn) btn.click();
      if (!d.querySelector('#btnSend.stop') && i > 2) break;
    }
    assert.ok(!d.querySelector('#btnSend.stop'), 'run finished: ' + text);
    return { errors: [...d.querySelectorAll('.msg.error')].map((x) => x.textContent), users: [...d.querySelectorAll('.msg.user')].map((x) => x.textContent), lifecycle: request ? request.trace.map((x) => x.state) : [], outcome: request && request.outcome };
  };
  const lastUser = (c) => c.messages[c.messages.length - 1].content;
  return { w, d, T, calls, net, script, say, pick, lastUser, newChat: () => d.getElementById('btnNew').click() };
}

(async () => {
  const { d, T, calls, net, script, say, pick, lastUser, newChat } = await boot();
  pick('Coder');
  let n = 0;

  // 1. a Python task end to end: the model answers in Markdown only (no tool tags) -> files are still written; it stops without running -> gate
  script.reply = (c, all) => {
    const k = all.length;
    if (k === 1) return 'Here is the tool.\n\n```python dedupe.py\nimport hashlib\n\ndef digest(data: bytes) -> str:\n    return hashlib.sha256(data).hexdigest()\n```\n\n```python\n# filename: test_dedupe.py\nfrom dedupe import digest\nassert len(digest(b"a")) == 64\nprint("ok")\n```\n';
    if (k === 2) return 'Both files are written. Done.';
    if (k === 3) return '<get_diagnostics/>';
    return '<attempt_completion>\n<result>dedupe.py and its test are in place; static checks pass.</result>\n</attempt_completion>';
  };
  let r = await say('Write a Python module that hashes files, with a test');
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.lifecycle.includes('WAITING_FOR_MODEL') && r.lifecycle.includes('SELECTING_TOOL') && r.lifecycle.includes('PROCESSING_RESULT'), 'the real send → model → tool → result lifecycle is traced');
  assert.strictEqual(r.lifecycle[r.lifecycle.length - 1], 'PARTIAL');
  assert.strictEqual(r.outcome.kind, 'partial', 'static diagnostics are not recorded as behavioral proof');
  assert.ok(T.ws.has('dedupe.py') && T.ws.get('test_dedupe.py').startsWith('from dedupe import digest'), 'files from named code fences were saved');
  assert.ok(/Created dedupe\.py[\s\S]*\[diagnostics: OK\]/.test(lastUser(calls[1])), 'auto-diagnostics after a write');
  assert.ok(/You modified code files but have not verified them yet/.test(lastUser(calls[2])), 'verification gate fired when the agent stopped');
  assert.strictEqual(calls.length, 4, 'gate fires once, attempt_completion ends the run');
  assert.ok(/<ROLE>/.test(calls[0].messages[0].content) && /<VERIFICATION_GATE>/.test(calls[0].messages[0].content) && /Repo map|Workspace/.test(calls[0].messages[0].content));
  assert.ok(/✅ dedupe\.py and its test are in place/.test(d.getElementById('messages').textContent), 'completion text is shown, not the raw tag');
  assert.ok(/not been verified|not verified|not behavioral proof/i.test(d.getElementById('messages').textContent), 'partial code completion is disclosed');
  const beforeOversize = calls.length, oversized = 'x'.repeat(40001);
  d.getElementById('input').value = oversized; d.getElementById('btnSend').click();
  assert.strictEqual(calls.length, beforeOversize, 'oversized input is rejected before provider traffic');
  assert.strictEqual(d.getElementById('input').value, oversized, 'rejected text is preserved for editing');
  assert.match(d.getElementById('toast').textContent, /too long/i);

  // 2. documentation only: no gate
  newChat(); pick('Coder');
  script.reply = (c, all) => (all.length === 1 ? '<write_file path="NOTES.md">\n# notes\n</write_file>' : 'Notes saved.');
  r = await say('Write a notes file'); assert.strictEqual(calls.length, 2, 'no verification round for a Markdown file');

  // 3. stuck loop: the same failing call twice -> one TROUBLESHOOTING warning
  newChat(); pick('Coder');
  const bad = '<edit_file path="dedupe.py">\n<search>def nothing_like_this():</search>\n<replace>x</replace>\n</edit_file>';
  script.reply = (c, all) => (all.length <= 3 ? bad : 'I will stop here.');
  r = await say('Change the function');
  assert.ok(!/<TROUBLESHOOTING>/.test(lastUser(calls[1])), 'first failure: plain error');
  assert.ok(/search text not found/.test(lastUser(calls[1])));
  assert.ok(/<TROUBLESHOOTING>[\s\S]*5-7 different possible sources/.test(lastUser(calls[2])), 'second identical failure: warning');
  assert.ok(!/<TROUBLESHOOTING>/.test(lastUser(calls[3])), 'the warning is not repeated');

  // 4. slash commands and @file
  newChat(); pick('Coder');
  script.reply = () => '1. Goal: a CLI.\n2. Files: cli.py';
  r = await say('/plan a CLI that prints file hashes using @dedupe.py');
  assert.strictEqual(calls[calls.length - 1].role, 'planner', '/plan runs the Planner whatever agent is selected');
  const planMsg = lastUser(calls[calls.length - 1]);
  assert.ok(/^\/plan a CLI/.test(planMsg) && /Do not write the code/.test(planMsg));
  assert.ok(/<attached_files>\n<file path="dedupe\.py">\nimport hashlib/.test(planMsg), '@file content is attached');
  assert.ok(/\/plan a CLI that prints file hashes using @dedupe\.py\n📎 dedupe\.py$/.test(r.users[r.users.length - 1]), 'the chat shows what was typed, not the expanded prompt');
  script.reply = (c, all) => (c.role === 'coder' && all.filter((x) => x.role === 'coder').length === 1 ? '<write_file path="cli.py">\nimport sys\nprint(sys.argv)\n</write_file>\n<run_terminal_command>\ngit init\n</run_terminal_command>' : c.role === 'coder' ? 'Built.' : 'LGTM');
  r = await say('/implement');
  assert.ok(calls.some((c) => c.role === 'coder') && T.ws.has('cli.py'), '/implement runs the Coder');
  const afterInit = calls.filter((c) => c.role === 'coder')[1];
  assert.ok(/Initialized empty repository/.test(lastUser(afterInit)), 'git is a working built-in for the agent: ' + lastUser(afterInit).slice(0, 300));
  script.reply = () => 'LGTM. Checked cli.py.'; await say('/review'); assert.strictEqual(calls[calls.length - 1].role, 'reviewer'); assert.ok(/git status/.test(lastUser(calls[calls.length - 1])));
  script.reply = () => '1. Who uses it?\n2. Which data?\n3. Offline?'; await say('/interview a habit tracker'); assert.ok(/ask 3 to 5 short, numbered questions/.test(lastUser(calls[calls.length - 1])));
  script.reply = (c, all) => (all.length === 1 ? '<write_file path="AGENTS.md">\n# Project\nRun: python cli.py\n</write_file>' : 'AGENTS.md written.'); r = await say('/init'); assert.ok(T.ws.has('AGENTS.md'), JSON.stringify(r.errors) + calls.map((c) => c.role + ':' + lastUser(c).slice(0, 200)).join(' || '));
  n = calls.length; d.getElementById('input').value = '/help'; d.getElementById('btnSend').click();
  await new Promise((r2) => setTimeout(r2, 100));
  assert.ok(/\/compact/.test([...d.querySelectorAll('.msg')].pop().textContent) && calls.length === n, '/help is answered locally, without a model call');
  script.reply = () => 'ok'; r = await say('/unknown thing'); assert.ok(/\/unknown thing/.test(lastUser(calls[0])), 'an unknown /word is sent as ordinary text');

  // 5. built-in git / curl / npm through the same command path the agent and the Terminal use
  let out = await T.runCommand('git status --short'); assert.ok(/\?\? cli\.py/.test(out.out), out.out);
  out = await T.runCommand('git commit -m "first"'); assert.strictEqual(out.code, 0, out.out);
  T.ws.set('cli.py', 'import sys\nprint(len(sys.argv))\n');
  out = await T.runCommand('git diff cli.py'); assert.ok(/-print\(sys\.argv\)\n\+print\(len\(sys\.argv\)\)/.test(out.out), out.out);
  out = await T.runCommand('git checkout -- cli.py'); assert.strictEqual(T.ws.get('cli.py'), 'import sys\nprint(sys.argv)');
  script.http = (url, o) => (/api\.test\/echo/.test(url) ? { status: 201, ctype: 'application/json', text: JSON.stringify({ got: o.body || null, method: o.method }) } : null);
  out = await T.runCommand("curl -s -X POST -H 'Content-Type: application/json' -d '{\"a\":1}' https://api.test/echo");
  assert.strictEqual(out.out, '{"got":"{\\"a\\":1}","method":"POST"}'); assert.strictEqual(net[net.length - 1].headers['Content-Type'], 'application/json');
  // the http_request tool goes the same way
  const hc = T.C.parseToolCalls('<http_request method="POST" url="https://api.test/echo" headers=\'{"X-K":"v"}\'>\n{"b":2}\n</http_request>');
  let hres = await T.C.runTools(hc, T.ws, { mode: 'auto', exec: (c, t) => T.runCommand(c, t) });
  assert.ok(!hres[0].ok && /DENIED/.test(hres[0].text), 'a POST is never sent without an approval, even in Auto mode');
  let asked = null;
  hres = await T.C.runTools(hc, T.ws, { mode: 'auto', exec: (c, t) => T.runCommand(c, t), approve: async (req) => { asked = req; return 'allow'; } });
  assert.ok(asked, 'the approval screen was asked');
  assert.ok(hres[0].ok && /HTTP 201/.test(hres[0].text) && /"got":"\{\\"b\\":2\}"/.test(hres[0].text), hres[0].text); assert.strictEqual(net[net.length - 1].headers['X-K'], 'v');
  script.http = (url) => ({ 'https://cdn.jsdelivr.net/npm/pad/package.json': { status: 200, text: JSON.stringify({ name: 'pad', version: '1.0.0', main: 'index.js' }) }, 'https://cdn.jsdelivr.net/npm/pad@1.0.0/index.js': { status: 200, text: 'module.exports = (s, n) => String(s).padStart(n, "0");' } }[url] || null);
  out = await T.runCommand('npm install pad'); assert.strictEqual(out.code, 0, out.out);
  assert.ok(T.ws.has('node_modules/pad/index.js') && JSON.parse(T.ws.get('package.json')).dependencies.pad === '^1.0.0', out.out);
  out = await T.runCommand('git status --short'); assert.ok(!/node_modules/.test(out.out) && /\?\? package\.json/.test(out.out), 'node_modules is not reported by git: ' + out.out);
  out = await T.runCommand('test_webapp missing.html'); assert.strictEqual(out.code, 2); assert.ok(/file not found/.test(out.out));

  // 6. /compact: one summary call, later requests carry the summary instead of the old turns
  script.reply = (c) => (c.role === 'summary' ? '## Goal\nA hashing CLI.\n## Decisions and constraints\nPython only.\n## Files (path: what it contains / what changed)\ncli.py: prints argv\n## Commands run and their results\ngit init: ok\n## Open problems\nnone\n## Next steps\nadd hashing' : 'Continuing.');
  const before = (await (async () => { await say('one more turn please'); return calls[calls.length - 1].messages.length; })());
  calls.length = 0; d.getElementById('input').value = '/compact'; d.getElementById('btnSend').click();
  for (let i = 0; i < 200 && !calls.some((c) => c.role === 'summary'); i++) await new Promise((r2) => setTimeout(r2, 25));
  await new Promise((r2) => setTimeout(r2, 200));
  assert.strictEqual(calls.filter((c) => c.role === 'summary').length, 1);
  r = await say('add hashing now');
  const msgs = calls[calls.length - 1].messages;
  assert.ok(msgs.length < before && msgs.length <= 4, 'history after /compact is short: ' + msgs.length + ' vs ' + before);
  assert.ok(/The conversation above was compacted[\s\S]*## Goal\nA hashing CLI/.test(msgs[1].content), 'the summary is what the model now sees');
  assert.ok(d.querySelectorAll('.msg').length > 6, 'the visible chat keeps its history');
  console.log('ENGINE UI TEST PASSED (tags)');

  // 7. native function calling: the request carries tool definitions and the function-calling rules, never the tag rules
  const B = await boot({ nativeTools: true });
  B.pick('Coder');
  B.script.reply = (c, all) => (all.length === 1 ? { native: [{ id: 'c1', type: 'function', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'create', path: 'srv/app.py', file_text: 'def handler(x):\n    return x * 2\n' }) } },
    { id: 'c2', type: 'function', function: { name: 'execute_bash', arguments: JSON.stringify({ command: 'git init' }) } }] } : 'Created.');
  r = await B.say('Create a handler');
  assert.deepStrictEqual(r.errors, []);
  const first = B.calls[0];
  assert.ok(Array.isArray(first.tools) && first.tools.some((t) => t.function.name === 'str_replace_editor') && first.tools.some((t) => t.function.name === 'apply_diff'), 'tool definitions sent');
  assert.ok(/Call the functions through function calling/.test(first.messages[0].content) && !/Tool tags are the only way/.test(first.messages[0].content) && !/Write the tags exactly as shown/.test(first.messages[0].content), 'native request does not also demand tags');
  assert.strictEqual(B.T.ws.get('srv/app.py'), 'def handler(x):\n    return x * 2', 'a native call under a borrowed tool name was executed');
  assert.ok(/Initialized empty repository/.test(B.lastUser(B.calls[1])), 'execute_bash alias ran');
  console.log('ENGINE UI TEST PASSED (native calls)');

  // A provider that ignores cancellation must not let its late response continue the request.
  const Z = await boot(); Z.pick('Coder'); Z.script.delay = 100;
  Z.d.getElementById('input').value = 'This request will be stopped'; Z.d.getElementById('btnSend').click();
  const stoppedRequest = Z.T.activeRequest; assert.ok(stoppedRequest, 'request lifecycle starts on send');
  Z.d.getElementById('btnSend').click();
  for (let i = 0; i < 100 && Z.d.querySelector('#btnSend.stop'); i++) await new Promise((r2) => setTimeout(r2, 10));
  assert.ok(!Z.d.querySelector('#btnSend.stop'), 'cancelled request releases the UI');
  assert.strictEqual(stoppedRequest.state, 'CANCELLED');
  assert.strictEqual(stoppedRequest.outcome.kind, 'cancelled');
  assert.strictEqual(Z.T.ws.list().length, 0, 'late provider output did not run tools or change files');
  assert.strictEqual(Z.calls.length, 1, 'no retry or follow-up request was launched after cancellation');
  console.log('ENGINE UI TEST PASSED (cancellation)');

  // A deterministic short fake deadline bounds a provider that never resolves and ignores abort.
  const Q = await boot(); Q.pick('Coder'); Q.script.never = true;
  Q.w.AgentRuntime.createDeadline = (parent) => {
    const ctl = new Q.w.AbortController(); let timedOut = false;
    const onParent = () => ctl.abort();
    if (parent) parent.addEventListener('abort', onParent, { once: true });
    const timer = Q.w.setTimeout(() => { timedOut = true; ctl.abort(); }, 5);
    return { signal: ctl.signal, timedOut: () => timedOut, dispose: () => { Q.w.clearTimeout(timer); if (parent) parent.removeEventListener('abort', onParent); } };
  };
  Q.d.getElementById('input').value = 'Model timeout test'; Q.d.getElementById('btnSend').click();
  const timeoutRequest = Q.T.activeRequest; assert.ok(timeoutRequest);
  for (let i = 0; i < 100 && Q.d.querySelector('#btnSend.stop'); i++) await new Promise((r2) => setTimeout(r2, 10));
  assert.ok(!Q.d.querySelector('#btnSend.stop'), 'deadline releases a hung request');
  assert.strictEqual(timeoutRequest.state, 'FAILED');
  assert.strictEqual(timeoutRequest.outcome.kind, 'failed');
  assert.strictEqual(Q.calls.length, 1, 'a timed-out non-idempotent model request is not replayed');
  assert.match(Q.d.querySelector('.msg.error').textContent, /timed out/);
  console.log('ENGINE UI TEST PASSED (deadline)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
