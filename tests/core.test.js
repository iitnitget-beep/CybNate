// Run with: node tests/core.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../app/src/main/assets/www/core.js');
const AUTO = { mode: 'auto' }; // these older tests exercise the tools themselves, not the approval gate

(async () => {
  const ws = new C.Workspace();
  const allowed = C.AGENTS.reverse.tools;

  // --- tool parsing
  const reply = 'Sure.\n<write_file path="index.html">\n<!doctype html>\n<h1>Hi</h1>\n</write_file>\nand\n' +
    '<write_file path="./js/app.js">\n```js\nconst a = 1 > 0;\n```\n</write_file>\n<list_files/>\n<read_file path="index.html" start="1" end="1"></read_file>';
  let calls = C.parseToolCalls(reply, allowed);
  assert.deepStrictEqual(calls.map((c) => c.name), ['write_file', 'write_file', 'list_files', 'read_file']);
  assert.strictEqual(calls[0].body, '<!doctype html>\n<h1>Hi</h1>');
  assert.strictEqual(calls[1].body, 'const a = 1 > 0;');
  let res = await C.runTools(calls, ws, AUTO);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  assert.deepStrictEqual(ws.list(), ['index.html', 'js/app.js']);
  assert.ok(res[3].text.includes('<!doctype html>') && !res[3].text.includes('<h1>'));

  // tools not allowed for an agent are ignored
  assert.strictEqual(C.parseToolCalls(reply, C.AGENTS.planner.tools).length, 2);
  assert.strictEqual(C.parseToolCalls('<think><delete_file path="index.html"/></think>ok', allowed).length, 0, 'tool tags inside hidden reasoning are ignored');
  assert.strictEqual(C.parseToolCalls(reply, C.AGENTS.chat.tools).length, 0);

  // --- edit_file exact + whitespace tolerant + failure
  ws.set('a.js', 'function f() {\n    return 1;\n}\nconst x = 2;\n');
  calls = C.parseToolCalls('<edit_file path="a.js">\n<search>const x = 2;</search>\n<replace>const x = 3;</replace>\n<search>\n  return 1;\n</search>\n<replace>\n    return 42;\n</replace>\n</edit_file>', allowed);
  res = await C.runTools(calls, ws, AUTO);
  assert.ok(res[0].ok, res[0].text);
  assert.strictEqual(ws.get('a.js'), 'function f() {\n    return 42;\n}\nconst x = 3;\n');
  res = await C.runTools(C.parseToolCalls('<edit_file path="a.js"><search>nope</search><replace>y</replace></edit_file>', allowed), ws, AUTO);
  assert.ok(!res[0].ok && /not found/.test(res[0].text));
  res = await C.runTools(C.parseToolCalls('<read_file path="missing.txt"/>', allowed), ws);
  assert.ok(!res[0].ok && /file not found/.test(res[0].text));

  // --- search / delete / path traversal is neutralised
  res = await C.runTools(C.parseToolCalls('<search_files query="return \\d+"/><delete_file path="a.js"/>', allowed), ws, AUTO);
  assert.ok(/a\.js:2/.test(res[0].text)); assert.ok(!ws.has('a.js'));
  assert.strictEqual(C.Workspace.norm('../../etc/./passwd'), 'etc/passwd');

  // --- display text
  const d = C.displayText('Working\n<write_file path="x.py">\nprint(1)\n</write_file>\n<write_file path="y.py">\nprint(');
  assert.ok(/🔧 \*\*write_file\*\* `x\.py`/.test(d) && /✍️ \*\*write_file\*\* `y\.py`/.test(d) && !/print/.test(d), d);
  assert.strictEqual(C.displayText('hello <rea'), 'hello ');

  // --- zip roundtrip (stored) + deflate read via python-made archive
  const z = C.zipCreate([{ name: 'a/b.txt', data: C.utf8('hello zip') }, { name: 'c.bin', data: new Uint8Array([0, 1, 2, 255]) }]);
  assert.deepStrictEqual(C.zipEntries(z).map((e) => e.name), ['a/b.txt', 'c.bin']);
  assert.strictEqual(Buffer.from(await C.zipRead(z, 'a/b.txt')).toString(), 'hello zip');
  require('child_process').execSync(`python3 -c "import zipfile;z=zipfile.ZipFile('/tmp/t.zip','w',zipfile.ZIP_DEFLATED);z.writestr('big.txt','abc'*5000);z.close()"`);
  const pz = new Uint8Array(fs.readFileSync('/tmp/t.zip'));
  assert.strictEqual((await C.zipRead(pz, 'big.txt')).length, 15000);
  require('child_process').execSync('cd /tmp && rm -rf zt && mkdir zt && cd zt && python3 -c "import zipfile;zipfile.ZipFile(\'/tmp/out.zip\').extractall(\'.\')" 2>/dev/null || true');

  // --- strings / hexdump
  const bin = new Uint8Array(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('https://api.example.com/v1'), Buffer.from([0, 0]), Buffer.from('secret_token', 'utf16le'), Buffer.from([0, 7])]));
  const s = C.extractStrings(bin, { min: 6 });
  assert.ok(s.items.includes('https://api.example.com/v1') && s.items.includes('secret_token'), JSON.stringify(s));
  assert.strictEqual(C.extractStrings(bin, { filter: 'https?://' }).total, 1);
  assert.ok(C.hexdump(bin, 0, 16).startsWith('00000000  00 01 02 68 74 74 70'));

  // --- SSE
  const p = C.createSseParser();
  let got = p.feed('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi');
  got = got.concat(p.feed('ces":[{"delta":{"content":"lo"}}]}\n\n: keepalive\ndata: [DONE]\n'));
  assert.strictEqual(got.map((g) => g.text).join(''), 'Hello');
  assert.ok(p.feed('data: {"error":{"message":"rate limited"}}\n')[0].error === 'rate limited');

  // --- model lists
  assert.deepStrictEqual(C.parseModelList({ data: [{ id: 'a/b:free' }, { id: 'c/d', pricing: { prompt: '1', completion: '1' } }] }, C.PROVIDERS.openrouter), ['a/b:free']);
  assert.deepStrictEqual(C.parseModelList([{ name: 'openai' }, { name: 'openai-audio' }], C.PROVIDERS.pollinations), ['openai']);
  assert.deepStrictEqual(C.parseModelList({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }] }, C.PROVIDERS.gemini), ['gemini-2.5-flash']);

  // --- history trimming
  const h = C.trimHistory([{ role: 'user', content: 'x'.repeat(50) }, { role: 'assistant', content: 'y'.repeat(50) }, { role: 'user', content: 'z' }], 60);
  assert.ok(h[h.length - 1].content.endsWith('\n\nz')); assert.strictEqual(h[0].role, 'user'); assert.strictEqual(h.length, 1);
  assert.ok(/compacted/.test(h[0].content) && /User requests so far:\n- x{50}/.test(h[0].content), 'dropped turns are replaced by a digest, not lost');
  assert.strictEqual(C.trimHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 1000)[0].content, 'a', 'nothing is added when everything fits');

  // --- real APK analysis (uses the CI-built APK when present)
  const apk = path.join(__dirname, '..', 'release', 'CybNate.apk');
  if (fs.existsSync(apk)) {
    ws.set('app.apk', new Uint8Array(fs.readFileSync(apk)));
    res = await C.runTools(C.parseToolCalls('<file_info path="app.apk"/><android_manifest path="app.apk"/><zip_extract path="app.apk" entry="classes.dex" dest="c.dex"/><file_info path="c.dex"/><strings path="c.dex" filter="cybnate/app/MainActivity" limit="5"/>', allowed), ws, AUTO);
    res.forEach((r) => assert.ok(r.ok, r.text));
    assert.ok(/Android APK/.test(res[0].text) && /classes\.dex/.test(res[0].text));
    assert.ok(/package="com\.cybnate\.app"/.test(res[1].text) && /android\.permission\.INTERNET/.test(res[1].text), res[1].text);
    assert.ok(/DEX version: 03\d/.test(res[3].text), res[3].text);
    assert.ok(/MainActivity/.test(res[4].text), res[4].text);
    console.log(res[0].text + '\n' + res[1].text.split('\n').slice(0, 6).join('\n'));
  } else console.log('(APK not present, skipped APK analysis test)');

  // --- commands, globs, new tools
  assert.deepStrictEqual(C.parseCommand('cd src && python3 -m unittest -v'), { kind: 'python', mode: 'module', argv: ['unittest', '-v'], cwd: 'src' });
  assert.deepStrictEqual(C.parseCommand('python -c "print(1 > 0)"'), { kind: 'python', mode: 'code', src: 'print(1 > 0)', argv: ['-c'], cwd: '' });
  assert.strictEqual(C.parseCommand('python a.py | head').kind, 'sh');
  assert.strictEqual(C.parseCommand('ls -la').kind, 'sh');
  assert.deepStrictEqual(C.parseCommand('pip install -U requests rich').argv, ['requests', 'rich']);
  assert.strictEqual(C.parseCommand('git push').kind, 'git'); // git is built in now (app.js runs it against snapshots + the GitHub API)
  assert.ok(C.matchGlob('**/*.js', 'a/b/c.js') && C.matchGlob('*.js', 'a/c.js') && !C.matchGlob('src/*.js', 'src/a/b.js') && C.matchGlob('src/**/*.{ts,js}', 'src/a/b.ts'));
  const env = { mode: 'auto', exec: async (c, t) => ({ code: c === 'false' ? 1 : 0, out: 'ran ' + c + ' ' + t, files: ['x.txt'] }), search: async (q) => [{ title: 'T', url: 'https://u', snippet: q }], readUrl: async (u) => 'page ' + u, spawn: async (t, p) => t + ' report: ' + p };
  calls = C.parseToolCalls('<run_terminal_command timeout="5">\nls &amp;&amp; echo hi\n</run_terminal_command><run_terminal_command>false</run_terminal_command><web_search query="q1"/><read_url url="https://a"/><spawn_agent type="thinker">why</spawn_agent><spawn_agent type="nope">x</spawn_agent><find_files pattern="*.html"/><write_todos>\n- [ ] a\n</write_todos>', C.AGENTS.coder.tools);
  res = await C.runTools(calls, ws, env);
  assert.ok(/^\$ ls && echo hi\nran ls && echo hi 5\n\[exit code 0\]\n\[files changed: x\.txt\]$/.test(res[0].text) && res[0].ok, res[0].text);
  assert.ok(!res[1].ok && /exit code 1/.test(res[1].text));
  assert.ok(/1\. T\n   https:\/\/u\n   q1/.test(res[2].text) && res[3].text === 'page https://a');
  assert.ok(res[4].text === 'thinker report: why' && !res[5].ok && /unknown agent type/.test(res[5].text));
  assert.ok(/index\.html/.test(res[6].text) && res[7].ok);
  assert.deepStrictEqual(C.followupsOf('x<suggest_followups>\n1. Add tests\n- Dark mode\n</suggest_followups>'), ['Add tests', 'Dark mode']);
  assert.ok(!/spawn_agent/.test(C.buildSystemPrompt('coder', '', '', { noSpawn: true })) && /Android system shell/.test(C.buildSystemPrompt('coder', '', '', { shell: true })));

  // --- twenty helper calls are executed in batches of at most six
  let activeHelpers = 0, peakHelpers = 0, completedHelpers = 0;
  const twentyHelpers = Array.from({ length: 20 }, (_, n) => ({ name: 'spawn_agent', attrs: { type: 'thinker' }, body: 'task-' + n }));
  const bounded = await C.runTools(twentyHelpers, ws, { spawn: async (_type, prompt) => {
    activeHelpers++; peakHelpers = Math.max(peakHelpers, activeHelpers);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeHelpers--; completedHelpers++; return 'finished ' + prompt;
  } });
  assert.strictEqual(completedHelpers, 20, 'all helpers completed');
  assert.strictEqual(peakHelpers, 6, 'the batch runs no more than MAX_PARALLEL helpers concurrently');
  assert.ok(bounded.every((r) => r.ok), 'all batched helper results are returned');

  // --- native function calls are converted to tags
  const nat = C.nativeCallsToText([
    { function: { name: 'write_file', arguments: '{"path": "ping.txt", "content": "pong"}' } },
    { name: 'run_command', arguments: { command: 'python a.py && echo "x"', timeout: 5 } },
    { name: 'read_files', arguments: { paths: ['a.py', 'b "q".py'] } },
    { name: 'str_replace', arguments: { path: 'a.py', old_string: 'x <1', new_string: 'y' } },
    { name: 'write_todos', arguments: { todos: [{ task: 'one', status: 'completed' }, 'two'] } },
    { name: 'spawn_agents', arguments: { agents: [{ agent_type: 'reviewer', prompt: 'check' }] } },
    { name: 'mystery', arguments: '{}' },
  ]);
  calls = C.parseToolCalls(nat, C.AGENTS.coder.tools);
  assert.deepStrictEqual(calls.map((c) => c.name), ['write_file', 'run_terminal_command', 'read_file', 'read_file', 'edit_file', 'write_todos', 'spawn_agent'], nat);
  assert.strictEqual(calls[0].body, 'pong'); assert.strictEqual(calls[0].attrs.path, 'ping.txt');
  assert.strictEqual(calls[1].body, 'python a.py && echo "x"'); assert.strictEqual(calls[1].attrs.timeout, '5');
  assert.strictEqual(calls[3].attrs.path, 'b "q".py');
  assert.deepStrictEqual(calls[4].edits, [{ search: 'x <1', replace: 'y' }]);
  assert.strictEqual(calls[5].body, '- [x] one\n- [ ] two'); assert.strictEqual(calls[6].attrs.type, 'reviewer');
  assert.ok(/unknown tool "mystery"/.test(nat));
  const sp = C.createSseParser();
  sp.feed('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write_file","arguments":"{\\"path\\": \\"p.txt\\","}}]}}]}\n\n');
  sp.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"content\\": \\"hi\\"}"}}]}}]}\n\n');
  assert.deepStrictEqual(sp.toolCalls(), [{ name: 'write_file', arguments: '{"path": "p.txt", "content": "hi"}' }]);

  assert.ok(C.buildSystemPrompt('coder', ws.summary()).includes('<write_file'));
  assert.ok(!C.buildSystemPrompt('chat', '').includes('write_file'));
  console.log('ALL CORE TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });

// ---- native function schemas and failed_generation recovery
(function () {
  const assert = require('assert');
  const C2 = require('../app/src/main/assets/www/core.js');
  const sc = C2.toolSchemas(C2.AGENTS.coder.tools);
  assert.strictEqual(sc.length, C2.AGENTS.coder.tools.length);
  sc.forEach((t) => { assert.strictEqual(t.type, 'function'); assert.ok(t.function.description.length > 5, t.function.name); assert.strictEqual(t.function.parameters.type, 'object'); });
  // every schema round-trips through the native-call converter into a parsable tag
  const sample = { write_file: { path: 'a.txt', content: 'hi' }, edit_file: { path: 'a.txt', edits: [{ search: 'a', replace: 'b' }] }, run_terminal_command: { command: 'ls' }, spawn_agent: { type: 'reviewer', prompt: 'x' }, write_todos: { todos: [{ task: 'a', done: true }] }, suggest_followups: { followups: ['a'] }, read_file: { path: 'a.txt' }, search_files: { query: 'x' }, find_files: { pattern: '*' }, web_search: { query: 'q' }, read_url: { url: 'https://e.com' }, delete_file: { path: 'a' }, list_files: {} };
  Object.keys(sample).forEach((n) => { const calls = C2.parseToolCalls(C2.nativeCallToText(n, sample[n]), C2.AGENTS.coder.tools); assert.strictEqual(calls.length, 1, n); assert.strictEqual(calls[0].name, n); });
  const groq = JSON.stringify({ error: { message: 'Tool choice is none, but model called a tool', code: 'tool_use_failed', failed_generation: '{"name": "write_file", "arguments": {"path": "index.html", "content": "<h1>x</h1>"}}' } });
  assert.ok(/<write_file path="index.html">/.test(C2.recoverFailedGeneration(groq)));
  assert.strictEqual(C2.recoverFailedGeneration('{"error":{"message":"nope"}}'), '');
  assert.ok(/Code Reuse/.test(C2.buildSystemPrompt('coder', '', '', {})));
  console.log('NATIVE TOOL SCHEMA TESTS PASSED');
})();

// ---- skills
(function () {
  const assert = require('assert');
  const C3 = require('../app/src/main/assets/www/core.js');
  const k = C3.parseSkill('---\nname: Test Driven Development\ndescription: >\n  Use when writing\n  any feature.\nlicense: MIT\n---\n# TDD\nWrite the test first.\n', 'x');
  assert.strictEqual(k.name, 'test-driven-development'); assert.strictEqual(k.description, 'Use when writing any feature.'); assert.ok(/^# TDD/.test(k.body));
  assert.strictEqual(C3.parseSkill('Just do it.\n', 'my skill').name, 'my-skill');
  const paths = ['README.md', 'skills/react-best-practices/SKILL.md', 'skills/tdd/SKILL.md', 'plugins/x/skills/tdd-extra/SKILL.md', 'skills/engineering/code-review/SKILL.md'];
  assert.strictEqual(C3.findSkillPath(paths, 'tdd'), 'skills/tdd/SKILL.md');
  assert.strictEqual(C3.findSkillPath(paths, 'vercel-react-best-practices'), 'skills/react-best-practices/SKILL.md');
  assert.strictEqual(C3.findSkillPath(paths, 'nothing-here'), '');
  const withSkills = C3.buildSystemPrompt('coder', '', '', { skills: [{ name: 'tdd', description: 'Use for features' }], secrets: ['API_KEY'] });
  assert.ok(/# Skills[\s\S]*- tdd: Use for features/.test(withSkills) && /<load_skill name=/.test(withSkills) && /API_KEY/.test(withSkills));
  assert.ok(!/load_skill/.test(C3.buildSystemPrompt('coder', '', '', {})));
  const calls = C3.parseToolCalls('<load_skill name="tdd"/>', C3.AGENTS.coder.tools);
  assert.strictEqual(calls[0].name, 'load_skill');
  C3.runTools(calls, new C3.Workspace(), { skill: (n) => 'BODY ' + n }).then((p) => { assert.ok(p[0].ok && /BODY tdd/.test(p[0].text)); console.log('SKILL TESTS PASSED'); });
})();
