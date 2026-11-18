// Deterministic reliability checks for the existing Core tool-execution API.
const assert = require('assert');
const C = require('../app/src/main/assets/www/core.js');
const Runtime = require('../app/src/main/assets/www/agent-runtime.js');

(async () => {
  const ws = new C.Workspace();
  const tool = (name, attrs, body) => ({ name, attrs: attrs || {}, body });

  // Existing result contract remains available to app.js and older callers.
  let parts = await C.runTools([tool('write_file', { path: 'src/a.js' }, 'export default 1;')], ws, { mode: 'auto' });
  ['label', 'ok', 'text'].forEach((key) => assert.ok(Object.prototype.hasOwnProperty.call(parts[0], key), 'legacy result key: ' + key));
  assert.strictEqual(typeof parts[0].label, 'string');
  assert.strictEqual(parts[0].ok, true);
  assert.strictEqual(typeof parts[0].text, 'string');
  assert.strictEqual(parts[0].status, 'success');

  // Fail closed on unsupported/malformed args, traversal, and tools outside the caller's allowlist.
  parts = await C.runTools([null], ws, { mode: 'auto' });
  assert.strictEqual(parts[0].status, 'failure');
  assert.match(parts[0].text, /unknown tool/);
  parts = await C.runTools([
    tool('read_file', { path: 'src/a.js', mystery: 'x' }),
    tool('write_file', { path: '../outside.txt' }, 'no'),
    tool('write_file', { path: 'allowed.txt' }, 'no'),
  ], ws, { mode: 'auto', allowedTools: ['read_file', 'write_file'] });
  assert.deepStrictEqual(parts.map((p) => p.status), ['failure', 'failure', 'success']);
  assert.match(parts[0].text, /unsupported argument/);
  assert.match(parts[1].text, /unsafe workspace path/);
  assert.strictEqual(ws.has('outside.txt'), false);
  parts = await C.runTools([tool('write_file', { path: 'folder/../inside.txt' }, 'safe')], ws, { mode: 'auto' });
  assert.strictEqual(parts[0].ok, true, 'safe normalized relative paths remain compatible');
  assert.strictEqual(ws.get('inside.txt'), 'safe');
  parts = await C.runTools([tool('write_file', { path: 'blocked2.txt' }, 'no')], ws, { mode: 'auto', allowedTools: ['read_file'] });
  assert.strictEqual(parts[0].status, 'failure');
  assert.match(parts[0].text, /not allowed for this agent/);
  assert.strictEqual(ws.has('blocked.txt'), false);

  // Exact duplicate side effects execute only once and retain result association/order.
  let spawnCount = 0;
  const repeated = [tool('spawn_agent', { type: 'thinker' }, 'inspect'), tool('spawn_agent', { type: 'thinker' }, 'inspect')];
  parts = await C.runTools(repeated, ws, { mode: 'auto', spawn: async () => { spawnCount++; return 'report'; } });
  assert.strictEqual(spawnCount, 1);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0].status, 'success');
  assert.strictEqual(parts[1].status, 'success');
  assert.strictEqual(parts[1].deduplicated, true);
  assert.match(parts[1].text, /original result reused/);

  // Distinct recovered unified diffs to the same path are not mistaken for duplicates.
  ws.set('src/d.js', 'x=1');
  const diffCalls = C.parseToolCalls('```diff\n--- a/src/d.js\n+++ b/src/d.js\n@@ -1 +1 @@\n-x=1\n+x=2\n```\n\n```diff\n--- a/src/d.js\n+++ b/src/d.js\n@@ -1 +1 @@\n-x=2\n+x=3\n```');
  parts = await C.runTools(diffCalls, ws, { mode: 'auto' });
  assert.strictEqual(parts.length, 2);
  assert.ok(parts.every((p) => p.ok), JSON.stringify(parts));
  assert.strictEqual(ws.get('src/d.js'), 'x=3');

  // Per-response cap is enforced without losing positional result mapping.
  let boundedRuns = 0;
  const many = Array.from({ length: 25 }, (_, i) => tool('spawn_agent', { type: 'thinker' }, 'task ' + i));
  parts = await C.runTools(many, ws, { mode: 'auto', spawn: async () => { boundedRuns++; return 'done'; } });
  assert.strictEqual(parts.length, 25);
  assert.strictEqual(boundedRuns, 24);
  assert.deepStrictEqual(parts.map((p) => p.status).slice(0, 24), new Array(24).fill('success'));
  assert.strictEqual(parts[24].status, 'failure');
  assert.match(parts[24].text, /limit 24/);

  // Tool order and prerequisite-stop policy are deterministic; non-zero exits are failures.
  const order = [];
  parts = await C.runTools([
    tool('run_terminal_command', {}, 'false'),
    tool('write_file', { path: 'not-run.txt' }, 'x'),
  ], ws, { mode: 'auto', stopOnFailure: true, exec: async (command) => { order.push(command); return { code: 1, out: 'intentional failure', files: [] }; } });
  assert.deepStrictEqual(order, ['false']);
  assert.deepStrictEqual(parts.map((p) => p.status), ['failure', 'cancelled']);
  assert.match(parts[1].text, /earlier tool failed/);
  assert.strictEqual(ws.has('not-run.txt'), false);
  parts = await C.runTools([tool('run_terminal_command', {}, 'slow')], ws, { mode: 'auto', exec: async () => ({ code: 124, timedOut: true, out: 'deadline', files: [] }) });
  assert.strictEqual(parts[0].status, 'timeout');
  assert.strictEqual(parts[0].code, 'timeout');
  parts = await C.runTools([
    tool('read_file', { path: 'missing.txt', ignored: true }),
    tool('write_file', { path: 'after-invalid.txt' }, 'x'),
  ], ws, { mode: 'auto', stopOnFailure: true });
  assert.strictEqual(parts[0].status, 'failure');
  assert.strictEqual(parts[1].status, 'cancelled');
  assert.strictEqual(ws.has('after-invalid.txt'), false);

  // Cancellation before execution never mutates the workspace.
  const controller = new AbortController(); controller.abort();
  parts = await C.runTools([tool('write_file', { path: 'cancelled.txt' }, 'x')], ws, { mode: 'auto', signal: controller.signal });
  assert.strictEqual(parts[0].status, 'cancelled');
  assert.strictEqual(ws.has('cancelled.txt'), false);
  const approvalController = new AbortController(); let releaseApproval;
  const waiting = C.runTools([tool('write_file', { path: 'pending.txt' }, 'x')], ws, {
    mode: 'ask', signal: approvalController.signal,
    approve: () => new Promise((resolve) => { releaseApproval = resolve; }),
  });
  assert.strictEqual(typeof releaseApproval, 'function', 'approval handler is awaited');
  approvalController.abort(); releaseApproval('allow');
  parts = await waiting;
  assert.strictEqual(parts[0].status, 'cancelled');
  assert.strictEqual(ws.has('pending.txt'), false);

  // Lifecycle primitives are deterministic and preserve the actual terminal outcome.
  assert.strictEqual(Runtime.validateUserRequest('  build it  '), 'build it');
  assert.throws(() => Runtime.validateUserRequest('  '), (e) => e.code === 'empty_request');
  let now = 0;
  const req = Runtime.createRequest('r1', 's1', () => ++now);
  req.transition('VALIDATING').transition('THINKING').finish({ kind: 'partial', reason: 'verification missing' });
  assert.strictEqual(req.state, 'PARTIAL');
  assert.throws(() => req.transition('FAILED'), (e) => e.code === 'illegal_transition');
  assert.strictEqual(Runtime.classifyOutcome({ changedFiles: ['src/a.js'], proof: false }).kind, 'partial');
  assert.deepStrictEqual(Runtime.classifyOutcome({ cancelled: true }).kind, 'cancelled');
  let timers = [];
  const deadline = Runtime.createDeadline(null, 10, { setTimeout: (fn) => { timers.push(fn); return 1; }, clearTimeout: () => {} });
  timers[0]();
  assert.strictEqual(deadline.timedOut(), true);
  assert.strictEqual(deadline.signal.aborted, true);
  deadline.dispose();

  console.log('AGENT RELIABILITY TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
