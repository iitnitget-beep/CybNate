// Tool engine added in the overhaul: borrowed tool names, tag-less edit recovery, new tools, undo, diagnostics, prompts.
const assert = require('assert');
const C = require('../app/src/main/assets/www/core.js');
const W = () => new C.Workspace();
const env = (over) => Object.assign({ mode: 'auto', exec: async (cmd) => ({ code: 0, out: 'ran:' + cmd.split('\n')[0] }) }, over || {});
const run = (ws, text, e) => C.runTools(C.parseToolCalls(text), ws, e || env());
const fails = async (p, re) => { let err; try { await p; } catch (e) { err = e; } assert.ok(err, 'expected a failure'); if (re) assert.ok(re.test(err.message), err.message); };

(async () => {
  // ---- 1. parser: XML, aliases from other agents
  let c = C.parseToolCalls('<execute_bash>\nls -la\n</execute_bash>');
  assert.strictEqual(c.length, 1); assert.strictEqual(c[0].name, 'run_terminal_command'); assert.strictEqual(c[0].body, 'ls -la');
  c = C.parseToolCalls('<execute_command>\n<command>pytest -q</command>\n</execute_command>');
  assert.strictEqual(c[0].body, 'pytest -q');
  c = C.parseToolCalls('<write_to_file>\n<path>src/a.py</path>\n<content>\nprint(1)\n</content>\n</write_to_file>');
  assert.strictEqual(c[0].name, 'write_file'); assert.strictEqual(c[0].attrs.path, 'src/a.py'); assert.strictEqual(c[0].body.trim(), 'print(1)');
  c = C.parseToolCalls('<replace_in_file>\n<path>a.py</path>\n<diff>\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE\n</diff>\n</replace_in_file>');
  assert.strictEqual(c[0].name, 'edit_file'); assert.strictEqual(c[0].attrs.path, 'a.py'); assert.ok(/SEARCH/.test(c[0].diffText));
  c = C.parseToolCalls('<execute_python>\nprint(2+2)\n</execute_python>');
  assert.strictEqual(c[0].name, 'run_terminal_command'); assert.strictEqual(c[0].via, 'execute_python');
  assert.deepStrictEqual(C.parseCommand(c[0].body), { kind: 'python', mode: 'code', src: 'print(2+2)', argv: ['-c'], cwd: '' });
  // end-of-turn tags are not tool calls
  assert.strictEqual(C.parseToolCalls('<attempt_completion>\n<result>Done.</result>\n</attempt_completion>').length, 0);
  assert.deepStrictEqual(C.isFinalReply('<ask_followup_question>\n<question>Which DB?</question>\n</ask_followup_question>'), { kind: 'ask', text: 'Which DB?' });
  assert.deepStrictEqual(C.isFinalReply('ok <attempt_completion>All tests pass.</attempt_completion>'), { kind: 'done', text: 'All tests pass.' });
  assert.strictEqual(C.isFinalReply('plain answer'), null);
  assert.ok(/Which DB\?/.test(C.displayText('<ask_followup_question>Which DB?</ask_followup_question>')));
  // `allowed` still limits: a reviewer without write tools gets nothing from borrowed names or code fences
  assert.strictEqual(C.parseToolCalls('<write_to_file><path>a.py</path><content>x</content></write_to_file>', ['read_file']).length, 0);
  assert.strictEqual(C.parseToolCalls('```python main.py\nprint(1)\n```', ['read_file', 'search_files']).length, 0);
  console.log('ALIAS PARSER TESTS PASSED');

  // ---- 2. native JSON function calls
  let t = C.nativeCallsToText([{ name: 'str_replace_editor', arguments: JSON.stringify({ command: 'str_replace', path: 'a.py', old_str: 'x = 1', new_str: 'x = 2' }) }]);
  c = C.parseToolCalls(t); assert.strictEqual(c[0].name, 'edit_file'); assert.deepStrictEqual(c[0].edits, [{ search: 'x = 1', replace: 'x = 2' }]);
  t = C.nativeCallsToText([{ name: 'execute_bash', arguments: '{"command":"python -m pytest"}' }]);
  c = C.parseToolCalls(t); assert.strictEqual(c[0].name, 'run_terminal_command'); assert.strictEqual(c[0].body, 'python -m pytest');
  t = C.nativeCallsToText([{ name: 'http_request', arguments: JSON.stringify({ method: 'post', url: 'https://x.test/api', headers: { 'Content-Type': 'application/json' }, body: { a: "it's" } }) }]);
  c = C.parseToolCalls(t); const pc = C.parseCommand(c[0].body);
  assert.strictEqual(pc.kind, 'curl'); assert.deepStrictEqual(pc.argv, ['-i', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-raw', '{"a":"it\'s"}', 'https://x.test/api']);
  t = C.nativeCallsToText([{ name: 'sqlite_query', arguments: JSON.stringify({ db: 'shop.db', query: 'SELECT 1' }) }]);
  c = C.parseToolCalls(t); assert.strictEqual(c[0].via, 'sqlite_query'); assert.ok(C.parseCommand(c[0].body).src.indexOf('sqlite3.connect') > 0);
  t = C.nativeCallsToText([{ name: 'test_webapp', arguments: JSON.stringify({ path: 'web/index.html', script: 'assert(document.title === "A")' }) }]);
  c = C.parseToolCalls(t); assert.deepStrictEqual(C.parseCommand(c[0].body), { kind: 'webtest', path: 'web/index.html', script: 'assert(document.title === "A")' });
  const schemaNames = C.toolSchemas(C.AGENTS.coder.tools).map((x) => x.function.name);
  ['str_replace_editor', 'apply_diff', 'execute_python', 'sqlite_query', 'http_request', 'test_webapp', 'get_diagnostics', 'list_code_definition_names', 'attempt_completion', 'ask_followup_question'].forEach((n) => assert.ok(schemaNames.indexOf(n) >= 0, 'schema ' + n));
  console.log('NATIVE CALL TESTS PASSED');

  // ---- 3. replies with no tool tag: Aider blocks, unified diffs, named fences
  let ws = W(); ws.set('calc.py', 'def add(a, b):\n    return a - b\n\ndef sub(a, b):\n    return a - b\n');
  let r = await run(ws, 'Fix:\n\ncalc.py\n```python\n<<<<<<< SEARCH\ndef add(a, b):\n    return a - b\n=======\ndef add(a, b):\n    return a + b\n>>>>>>> REPLACE\n```\n');
  assert.strictEqual(r.length, 1); assert.ok(r[0].ok, r[0].text); assert.ok(/return a \+ b/.test(ws.get('calc.py')));
  ws = W(); ws.set('m.py', 'import os\n\ndef main():\n    print("hi")\n    return 0\n');
  r = await run(ws, '```diff\n--- a/m.py\n+++ b/m.py\n@@ -3,3 +3,4 @@\n def main():\n     print("hi")\n+    print("there")\n     return 0\n```');
  assert.ok(r[0].ok, r[0].text); assert.ok(/print\("there"\)\n    return 0/.test(ws.get('m.py')));
  ws = W();
  r = await run(ws, 'Here it is:\n\n```python main.py\nprint("a")\n```\n\nand\n\n```js\n// filename: src/util.js\nmodule.exports = 1;\n```\n');
  assert.strictEqual(r.length, 2); assert.strictEqual(ws.get('main.py'), 'print("a")'); assert.strictEqual(ws.get('src/util.js'), 'module.exports = 1;');
  assert.ok(/use write_file/.test(r[0].text));
  // not recovered: no file name, shell output, elided code, or when a real write tag is present
  assert.strictEqual(C.parseToolCalls('```python\nprint(1)\n```').length, 0);
  assert.strictEqual(C.parseToolCalls('```python main.py\ndef a():\n    pass\n# ... rest of the code ...\n```').length, 0);
  c = C.parseToolCalls('<write_file path="a.py">\nx=1\n</write_file>\nFor reference:\n```python b.py\ny=2\n```');
  assert.deepStrictEqual(c.map((x) => x.attrs.path), ['a.py']);
  console.log('TAGLESS RECOVERY TESTS PASSED');

  // ---- 4. str_replace_editor
  ws = W();
  r = await run(ws, '<str_replace_editor command="create" path="app/s.py">\n<file_text>\ndef f():\n    return 1\n\ndef g():\n    return 1\n</file_text>\n</str_replace_editor>');
  assert.ok(r[0].ok, r[0].text); assert.ok(/\[diagnostics: OK\]/.test(r[0].text));
  r = await run(ws, '<str_replace_editor command="view" path="app/s.py" view_range="1,2"/>');
  assert.ok(/ 1\| def f\(\):\n\s+2\|     return 1/.test(r[0].text), r[0].text);
  r = await run(ws, '<str_replace_editor command="str_replace" path="app/s.py">\n<old_str>    return 1</old_str>\n<new_str>    return 2</new_str>\n</str_replace_editor>');
  assert.ok(!r[0].ok && /more than once \(lines 2, 5\)/.test(r[0].text), r[0].text);
  r = await run(ws, '<str_replace_editor command="str_replace" path="app/s.py">\n<old_str>def g():\n    return 1</old_str>\n<new_str>def g():\n    return 2</new_str>\n</str_replace_editor>');
  assert.ok(r[0].ok, r[0].text); assert.ok(/def g\(\):\n    return 2/.test(ws.get('app/s.py')));
  r = await run(ws, '<str_replace_editor command="insert" path="app/s.py" insert_line="0">\n<new_str>import sys</new_str>\n</str_replace_editor>');
  assert.ok(r[0].ok && ws.get('app/s.py').startsWith('import sys\ndef f():'), r[0].text);
  r = await run(ws, '<str_replace_editor command="undo_edit" path="app/s.py"/>');
  assert.ok(r[0].ok && ws.get('app/s.py').startsWith('def f():') && /return 2/.test(ws.get('app/s.py')), r[0].text);
  await run(ws, '<str_replace_editor command="undo_edit" path="app/s.py"/>'); assert.ok(!/return 2/.test(ws.get('app/s.py')));
  r = await run(ws, '<str_replace_editor command="undo_edit" path="app/s.py"/>'); assert.ok(r[0].ok && !ws.has('app/s.py'), 'undo of the creation removes the file');
  r = await run(ws, '<str_replace_editor command="undo_edit" path="app/s.py"/>'); assert.ok(!r[0].ok && /nothing to undo/.test(r[0].text));
  r = await run(ws, '<str_replace_editor command="explode" path="a"/>'); assert.ok(!r[0].ok && /unknown command/.test(r[0].text));
  console.log('STR_REPLACE_EDITOR TESTS PASSED');

  // ---- 5. apply_diff + fuzzy edit_file + diagnostics
  ws = W(); ws.set('srv.js', 'function a() {\n\treturn 1;\n}\n\nfunction b() {\n\treturn 2;\n}\n');
  r = await run(ws, '<apply_diff path="srv.js">\n@@ -5,3 +5,3 @@\n function b() {\n-    return 2;\n+    return 3;\n }\n</apply_diff>');
  assert.ok(r[0].ok, r[0].text); assert.ok(/return 3;/.test(ws.get('srv.js')) && /\[diagnostics: OK\]/.test(r[0].text), r[0].text);
  r = await run(ws, '<apply_diff path="srv.js">\n<<<<<<< SEARCH\nfunction a() {\n=======\nfunction a( {\n>>>>>>> REPLACE\n</apply_diff>');
  assert.ok(r[0].ok && /\[diagnostics: ERROR in srv\.js/.test(r[0].text), r[0].text);
  r = await run(ws, '<get_diagnostics path="srv.js"/>'); assert.ok(/\d problems?:/.test(r[0].text), r[0].text);
  r = await run(ws, '<edit_file path="srv.js">\n<search>function zzz() {\n\treturn 99;\n}</search>\n<replace>x</replace>\n</edit_file>');
  assert.ok(!r[0].ok && /search text not found/.test(r[0].text));
  r = await run(ws, '<edit_file path="srv.js">\n<search>function b() {\n   return 3;   \n}</search>\n<replace>function b() {\n   return 4;\n}</replace>\n</edit_file>');
  assert.ok(r[0].ok && /matched loosely/.test(r[0].text) && /\treturn 4;/.test(ws.get('srv.js')), r[0].text + JSON.stringify(ws.get('srv.js')));
  r = await run(ws, '<apply_diff path="srv.js">\nnothing useful\n</apply_diff>'); assert.ok(!r[0].ok && /no usable diff/.test(r[0].text));
  ws.set('page.html', '<html><body><script src="missing.js"></script></body></html>');
  r = await run(ws, '<get_diagnostics/>'); assert.ok(/missing\.js/.test(r[0].text), r[0].text);
  console.log('APPLY_DIFF / FUZZY / DIAGNOSTICS TESTS PASSED');

  // ---- 6. definitions + repo map in the prompt
  ws = W(); ws.set('api/app.py', 'class Shop:\n    def total(self):\n        return 1\n\ndef main():\n    pass\n'); ws.set('lib/x.go', 'package x\n\nfunc Run() error {\n\treturn nil\n}\n');
  r = await run(ws, '<list_code_definition_names path="api"/>');
  assert.ok(/api\/app\.py/.test(r[0].text) && /class Shop/.test(r[0].text) && /main\(\)/.test(r[0].text) && !/x\.go/.test(r[0].text), r[0].text);
  assert.ok(/Repo map/.test(ws.summary()) && /Run\(\):3/.test(ws.summary()), ws.summary());
  const sys = C.buildSystemPrompt('coder', ws.summary(), '', {});
  ['<ROLE>', '<EFFICIENCY>', '<FILE_SYSTEM_GUIDELINES>', '<ENVIRONMENT_SETUP>', '<TROUBLESHOOTING>', '<VERIFICATION_GATE>'].forEach((b) => assert.ok(sys.indexOf(b) >= 0, 'prompt block ' + b));
  assert.ok(/5-7 (different )?possible sources/.test(sys)); assert.ok(/Shop:1/.test(sys));
  assert.ok(!/index\.html/.test(C.buildSystemPrompt('coder', '', '', {}).replace(/test_webapp[^\n]*/g, '')), 'no index.html default example in the coder prompt');
  ['file_picker', 'explorer', 'planner', 'thinker', 'editor', 'basher', 'reviewer', 'researcher'].forEach((n) => assert.ok(C.SUBAGENT_TYPES.indexOf(n) >= 0, 'sub-agent ' + n));
  console.log('REPO MAP / PROMPT TESTS PASSED');

  // ---- 7. commands
  assert.deepStrictEqual(C.parseCommand('npm install lodash dayjs --save'), { kind: 'npm', sub: 'install', pkgs: ['lodash', 'dayjs'], dev: false, cwd: '' });
  assert.deepStrictEqual(C.parseCommand('npm test'), { kind: 'npm', sub: 'run', script: 'test', cwd: '' });
  assert.deepStrictEqual(C.parseCommand('git diff src/a.py'), { kind: 'git', argv: ['diff', 'src/a.py'], cwd: '' });
  assert.deepStrictEqual(C.parseCommand('git commit -m "fix: total"').argv, ['commit', '-m', 'fix: total']);
  assert.strictEqual(C.parseCommand('curl -s https://a.test | head').kind, 'sh');
  assert.deepStrictEqual(C.parseCommand("cd web && test_webapp index.html <<'JS'\nassert(1)\nJS"), { kind: 'webtest', path: 'web/index.html', script: 'assert(1)' });
  // sub-agent write rule and the approval gate still see the real operation behind a borrowed tool name
  r = await run(W(), '<apply_diff path="a.py">\n--- /dev/null\n+++ b/a.py\n@@ -0,0 +1 @@\n+x = 1\n</apply_diff>', env({ writeError: (p) => 'read-only helper: ' + p }));
  assert.ok(!r[0].ok && /read-only helper: a\.py/.test(r[0].text), r[0].text);
  let asked = null; ws = W(); ws.set('a.py', 'x = 1\n');
  r = await C.runTools(C.parseToolCalls('<str_replace_editor command="str_replace" path="a.py"><old_str>x = 1</old_str><new_str>x = 2</new_str></str_replace_editor>'), ws, env({ mode: 'ask', approve: async (req) => { asked = req; return { ok: false }; } }));
  assert.ok(asked, 'the approval gate was asked'); assert.ok(!r[0].ok); assert.strictEqual(ws.get('a.py'), 'x = 1\n');
  console.log('COMMAND / GATE TESTS PASSED');
  console.log('ALL ENGINE TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
