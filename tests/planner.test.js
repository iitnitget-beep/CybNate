// Deterministic structured-planner contract tests; no model, network, workspace writes or timers.
const assert = require('assert');
const Planner = require('../app/src/main/assets/www/planner.js');
const task = (id, dependsOn) => ({ id, title: 'Task ' + id, detail: 'Implement ' + id, verify: 'Check ' + id, dependsOn: dependsOn || [] });
const plan = (tasks) => ({ goal: 'Build a reliable feature', rationale: 'Keep work incremental', tasks: tasks || [task('a')] });
const rejects = (fn, code) => assert.throws(fn, (e) => e && e.code === code);

const cases = [
  ['parses a direct JSON object', () => assert.strictEqual(Planner.parse(JSON.stringify(plan())).goal, plan().goal)],
  ['parses a fenced JSON object', () => assert.strictEqual(Planner.parse('```json\n' + JSON.stringify(plan()) + '\n```').tasks.length, 1)],
  ['extracts one JSON object from surrounding prose', () => assert.strictEqual(Planner.parse('Plan follows: ' + JSON.stringify(plan()) + ' end').tasks.length, 1)],
  ['canonicalizes schema version and safe text', () => { const p = Planner.validate({ goal: '  A\n B  ', tasks: [task('a')] }); assert.strictEqual(p.version, 1); assert.strictEqual(p.goal, 'A B'); }],
  ['topologically orders dependencies stably', () => assert.deepStrictEqual(Planner.validate(plan([task('last', ['first']), task('first'), task('ready')])).tasks.map((x) => x.id), ['first', 'last', 'ready'])],
  ['rejects non-object plans', () => rejects(() => Planner.validate([]), 'invalid_plan')],
  ['rejects unsupported top-level keys', () => rejects(() => Planner.validate(Object.assign(plan(), { executable: true })), 'invalid_plan')],
  ['requires a goal', () => rejects(() => Planner.validate({ tasks: [task('a')] }), 'invalid_plan')],
  ['requires tasks', () => rejects(() => Planner.validate({ goal: 'x' }), 'invalid_tasks')],
  ['rejects an empty task list', () => rejects(() => Planner.validate(plan([])), 'invalid_tasks')],
  ['bounds task count', () => rejects(() => Planner.validate(plan(Array.from({ length: 25 }, (_, i) => task('t' + i)))), 'invalid_tasks')],
  ['rejects unsupported task fields', () => rejects(() => Planner.validate(plan([Object.assign(task('a'), { command: 'rm -rf /' })])), 'invalid_task')],
  ['rejects non-text task fields', () => rejects(() => Planner.validate(plan([Object.assign(task('a'), { detail: { command: 'x' } })])), 'invalid_task')],
  ['rejects duplicate identifiers', () => rejects(() => Planner.validate(plan([task('a'), task('a')])), 'invalid_id')],
  ['rejects invalid identifiers', () => rejects(() => Planner.validate(plan([task('bad id')])), 'invalid_id')],
  ['requires task titles', () => rejects(() => Planner.validate(plan([Object.assign(task('a'), { title: '' })])), 'incomplete_task')],
  ['requires task details', () => rejects(() => Planner.validate(plan([Object.assign(task('a'), { detail: '' })])), 'incomplete_task')],
  ['requires verification per task', () => rejects(() => Planner.validate(plan([Object.assign(task('a'), { verify: '' })])), 'incomplete_task')],
  ['requires dependency arrays', () => rejects(() => Planner.validate(plan([Object.assign(task('a'), { dependsOn: 'b' })])), 'invalid_dependencies')],
  ['rejects unknown dependencies', () => rejects(() => Planner.validate(plan([task('a', ['missing'])])), 'unknown_dependency')],
  ['rejects duplicate dependencies', () => rejects(() => Planner.validate(plan([task('a', ['b', 'b']), task('b')])), 'invalid_dependencies')],
  ['rejects self dependencies', () => rejects(() => Planner.validate(plan([task('a', ['a'])])), 'invalid_dependencies')],
  ['rejects dependency cycles', () => rejects(() => Planner.validate(plan([task('a', ['b']), task('b', ['a'])])), 'dependency_cycle')],
  ['reports malformed JSON', () => rejects(() => Planner.parse('{oops'), 'invalid_json')],
  ['formats explicit advisory and non-persistence semantics', () => assert.match(Planner.format(plan()), /in memory; advisory, not executed or persisted/)],
  ['formats a previously validated canonical plan', () => assert.match(Planner.format(Planner.parse(JSON.stringify(plan()))), /Build a reliable feature/)],
  ['allows exactly one bounded replan', () => { assert.strictEqual(Planner.canReplan(0), true); assert.strictEqual(Planner.canReplan(1), false); assert.strictEqual(Planner.canReplan(2), false); }],
  ['exposes deterministic limits', () => assert.deepStrictEqual(Planner.limits(), { maxTasks: 24, maxReplans: 1 })],
];
for (const [name, run] of cases) { try { run(); } catch (e) { e.message = name + ': ' + e.message; throw e; } }
assert.strictEqual(cases.length, 28, 'the deterministic planner suite contains 28 independent cases');
console.log('PLANNER TESTS PASSED (' + cases.length + ' cases)');
