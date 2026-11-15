/* On-device self test. Started with:  adb shell am start -n com.cybnate.app/.MainActivity --ez selftest true
 * Results are written to logcat (tag CybNateJS) and shown on screen. */
(async function () {
  const T = window.__cyb; const lines = [];
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;inset:0;z-index:99;margin:0;background:#0b0f0e;color:#e6f2ec;font:11px monospace;padding:10px;overflow:auto;white-space:pre-wrap';
  document.body.appendChild(box);
  const say = (name, ok, detail) => { const l = 'CYBTEST ' + (ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 260) : ''); lines.push(l); console.log(l); box.textContent = lines.join('\n'); };
  const test = async (name, fn) => { try { const d = await fn(); say(name, true, d); } catch (e) { say(name, false, e && e.message ? e.message : e); } };
  const must = (c, m) => { if (!c) throw new Error(m); };
  console.log('CYBTEST START ua=' + navigator.userAgent);

  T.ws.list().forEach((p) => T.ws.remove(p));
  T.ws.set('hello.py', 'import json, sys\nprint(json.dumps({"sum": sum(range(10)), "py": sys.version_info[:2]}))\nopen("out.txt", "w").write("made by python\\n")\n');
  T.ws.set('lib/add.js', 'module.exports = (a, b) => a + b;\n');
  T.ws.set('main.js', 'const add = require("./lib/add");\nconst fs = require("fs");\nconsole.log("node says", add(2, 3));\nfs.writeFileSync("js.txt", "made by js");\n');

  await test('shell echo + workspace mirror', async () => { const r = await T.runCommand('ls && cat lib/add.js | wc -c && echo done', 30); must(r.code === 0 && /hello\.py/.test(r.out) && /done/.test(r.out), JSON.stringify(r)); return r.out; });
  await test('shell writes file back into workspace', async () => { const r = await T.runCommand('mkdir -p gen && echo from-shell > gen/a.txt && rm lib/add.js && echo x >> main.js', 30); must(r.code === 0, r.out); must(T.ws.get('gen/a.txt') === 'from-shell\n', 'gen/a.txt=' + T.ws.get('gen/a.txt')); must(!T.ws.has('lib/add.js'), 'delete not synced'); must(/x\n$/.test(T.ws.get('main.js')), 'append not synced'); return r.files.join(','); });
  await test('shell tools available', async () => { const r = await T.runCommand('for c in grep sed awk find sort tar gzip sha256sum diff curl wget python3 git; do command -v $c >/dev/null 2>&1 && echo "+$c" || echo "-$c"; done | tr "\\n" " "', 30); return r.out; });
  T.ws.set('lib/add.js', 'module.exports = (a, b) => a + b;\n'); T.ws.set('main.js', T.ws.get('main.js').replace(/x\n$/, ''));
  await test('python runs + file sync', async () => { const r = await T.runCommand('python hello.py', 120); must(r.code === 0 && /"sum": 45/.test(r.out), JSON.stringify(r).slice(0, 300)); must(T.ws.get('out.txt') === 'made by python\n', 'out.txt missing'); return r.out; });
  await test('python file visible to shell', async () => { const r = await T.runCommand('cat out.txt', 30); must(/made by python/.test(r.out), r.out); return r.out; });
  await test('python error exit code', async () => { const r = await T.runCommand('python -c "import sys; print(1/0)"', 60); must(r.code === 1 && /ZeroDivisionError/.test(r.out), JSON.stringify(r).slice(0, 300)); return 'traceback ok'; });
  await test('python numpy from CDN', async () => { const r = await T.runCommand('python -c "import numpy as np; print(np.arange(6).reshape(2,3).sum())"', 180); must(r.code === 0 && /15/.test(r.out), r.out); return r.out; });
  await test('pip install pure package', async () => { const r = await T.runCommand('pip install cowsay', 180); must(r.code === 0, r.out); const r2 = await T.runCommand('python -c "import cowsay; cowsay.cow(\'moo\')"', 60); must(/moo/.test(r2.out), r2.out); return 'cowsay ok'; });
  await test('node runs + require + fs', async () => { const r = await T.runCommand('node main.js', 30); must(r.code === 0 && /node says 5/.test(r.out), JSON.stringify(r).slice(0, 300)); must(T.ws.get('js.txt') === 'made by js', 'js.txt'); return r.out; });
  await test('timeout kills runaway python', async () => { const t = Date.now(); const r = await T.runCommand('python -c "while True: pass"', 3); must(r.timedOut, JSON.stringify(r)); const r2 = await T.runCommand('python -c "print(7*6)"', 120); must(/42/.test(r2.out), 'python did not recover: ' + r2.out); return (Date.now() - t) + ' ms incl. restart'; });

  await test('pollinations model list', async () => { const l = await T.fetchModels('pollinations'); return l.length + ' models: ' + l.slice(0, 12).join(','); });
  await test('pollinations chat (keyless)', async () => { T.settings.provider = 'pollinations'; const l = T.settings.models.pollinations || []; T.settings.model = l.indexOf('openai-fast') >= 0 ? 'openai-fast' : (l[0] || 'openai-fast'); const r = await T.chatStream([{ role: 'user', content: 'Reply with exactly: CYB-OK' }], () => {}); return 'model=' + T.settings.model + ' reply=' + r; });
  const nap = (s) => new Promise((r) => setTimeout(r, s * 1000));
  const dump = (label, t) => { for (let i = 0; i < Math.min(t.length, 9000); i += 2800) console.log('CYBTEST RAW ' + label + ' [' + i + '] ' + t.slice(i, i + 2800).replace(/\n/g, '\\n')); };
  await test('agent tool call from real model', async () => { await nap(47); const sys = T.C.buildSystemPrompt('coder', T.ws.summary(), '', { shell: true }); const r = await T.chatStream([{ role: 'system', content: sys }, { role: 'user', content: 'Create a file named ping.txt containing the single word pong.' }], () => {}, undefined, T.C.AGENTS.coder.tools); const calls = T.C.parseToolCalls(r, T.C.AGENTS.coder.tools); must(calls.some((c) => c.name === 'write_file'), 'no write_file call in: ' + r); return 'variant=' + T.chatStream.lastVariant + ' ' + calls.map((c) => c.name + ':' + (c.attrs.path || '')).join(' '); });
  await test('full agent run through the UI', async () => {
    await nap(47); box.style.display = 'none';
    document.getElementById('input').value = 'Write fizz.py that prints FizzBuzz for 1 to 15, run it, and tell me the last line of the output.';
    document.getElementById('btnSend').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 420000) { await new Promise((r) => setTimeout(r, 1500)); if (!document.querySelector('#btnSend.stop')) break; }
    box.style.display = '';
    const errs = [...document.querySelectorAll('.msg.error')].map((n) => n.textContent).join(' | ');
    const tools = [...document.querySelectorAll('.msg.tool summary')].map((n) => n.textContent).join(' | ');
    const lastMsg = ([...document.querySelectorAll('.msg.assistant')].pop() || {}).innerText || '';
    must(T.ws.has('fizz.py'), 'fizz.py was not created. errors=' + errs + ' tools=' + tools + ' last=' + lastMsg.slice(0, 200));
    must(/python/.test(tools), 'the agent did not run the script. tools=' + tools);
    return Math.round((Date.now() - t0) / 1000) + 's tools=[' + tools + '] errors=[' + errs + '] final=' + lastMsg.replace(/\s+/g, ' ').slice(-140);
  });
  await test('web search', async () => { const r = await T.webSearch('pyodide documentation'); must(r.length > 0, 'no results'); return r.length + ' results; first: ' + r[0].title + ' ' + r[0].url; });
  await test('read url', async () => { const t = await T.readUrl('https://example.com'); must(/Example Domain/.test(t), t.slice(0, 200)); return t.slice(0, 80); });
  await test('github api reachable (CORS)', async () => { const r = await fetch('https://api.github.com/repos/CodebuffAI/freebuff'); must(r.ok, 'HTTP ' + r.status); return (await r.json()).full_name; });

  const fails = lines.filter((l) => /FAIL/.test(l)).length;
  console.log('CYBTEST DONE pass=' + (lines.length - fails) + ' fail=' + fails);
  box.textContent = lines.join('\n') + '\n\nDONE pass=' + (lines.length - fails) + ' fail=' + fails;
})();
