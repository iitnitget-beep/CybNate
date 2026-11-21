// Run with: node tests/evals.test.js
// Offline evals: fixed scripted model replies run through the real parser and
// tool runner. No network, no API keys — these guard the agent loop against
// regressions in tool-call parsing (including weak-model malformations) and
// basic end-to-end task completion. Live-model evals would need keys; this
// suite is the deterministic floor every release must pass.
const assert = require('assert');
const C = require('../app/src/main/assets/www/core.js');
const AUTO = { mode: 'auto' };

const CASES = [
  {
    name: 'create a file from XML tags',
    reply: 'Creating it now.\n<write_file path="hello.txt">\nHello CybNate\n</write_file>',
    check: (ws, res) => ws.get('hello.txt') === 'Hello CybNate' && res[0].ok,
  },
  {
    name: 'native JSON call with trailing comma (weak model)',
    native: ['write_file', '{"path":"a.txt","content":"hi",}'],
    check: (ws, res) => ws.get('a.txt') === 'hi' && res[0].ok,
  },
  {
    name: 'native JSON call wrapped in prose and fences',
    native: ['write_file', 'Sure! ```json\n{"path":"b.txt","content":"yo"}\n``` done'],
    check: (ws, res) => ws.get('b.txt') === 'yo' && res[0].ok,
  },
  {
    name: 'alias tool names from other agents (write_to_file, ls)',
    reply: '<write_to_file path="c.txt">\nbody\n</write_to_file><ls/>',
    check: (ws, res) => ws.get('c.txt') === 'body' && res.every((r) => r.ok),
  },
  {
    name: 'tool tags inside hidden reasoning are ignored',
    reply: '<think><write_file path="nope.txt">x</write_file></think>Just thinking.',
    check: (ws, res) => !ws.has('nope.txt') && res.length === 0,
  },
  {
    name: 'edit then verify by reading back',
    setup: (ws) => ws.set('x.js', 'const n = 1;\n'),
    reply: '<edit_file path="x.js">\n<search>const n = 1;</search>\n<replace>const n = 2;</replace>\n</edit_file><read_file path="x.js"/>',
    check: (ws, res) => ws.get('x.js') === 'const n = 2;\n' && res[1].text.includes('const n = 2;'),
  },
  {
    name: 'path traversal is neutralised, file lands inside workspace',
    reply: '<write_file path="../../etc/evil.txt">\nnope\n</write_file>',
    check: (ws) => ws.has('etc/evil.txt') && !ws.list().some((p) => p.includes('..')),
  },
  {
    name: 'unknown tool is ignored, known tool still runs',
    reply: '<fly_to_moon/>\n<write_file path="ok.txt">\nfine\n</write_file>',
    check: (ws, res) => ws.get('ok.txt') === 'fine' && res.length === 1,
  },
  {
    name: 'hopeless native args are reported, nothing runs',
    native: ['write_file', 'definitely not json'],
    check: (ws, res, text) => text.includes('malformed call') && ws.list().length === 0 && res.length === 0,
  },
  {
    name: 'multi-file project in one reply',
    reply: '<write_file path="index.html">\n<h1>Hi</h1>\n</write_file>\n<write_file path="js/app.js">\nconsole.log(1);\n</write_file>\n<list_files/>',
    check: (ws, res) => ws.has('index.html') && ws.has('js/app.js') && res[2].text.includes('index.html'),
  },
];

(async () => {
  let passed = 0;
  for (const c of CASES) {
    const ws = new C.Workspace();
    if (c.setup) c.setup(ws);
    let text = c.reply || '';
    if (c.native) text = C.nativeCallToText(c.native[0], c.native[1]);
    const calls = C.parseToolCalls(text, C.AGENTS.coder.tools);
    const res = calls.length ? await C.runTools(calls, ws, AUTO) : [];
    assert.ok(c.check(ws, res, text), 'eval failed: ' + c.name);
    passed++;
  }
  console.log('EVALS PASSED (' + passed + '/' + CASES.length + ')');
})().catch((e) => { console.error(e); process.exit(1); });
