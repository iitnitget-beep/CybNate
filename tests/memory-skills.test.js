'use strict';
/* Day 8 — Agent memory and skills: explicit memory (preferences, facts, outcomes, tool usage)
   with review/edit/delete/export privacy controls, agent suggestions pending until approved,
   secrets refused, prompt block with active entries only; skills lifecycle with discovery,
   versioned install/upgrade, enable/disable, removal, and approval-bypass fields rejected. */
const assert = require('node:assert');
const AgentMemory = require('../app/src/main/assets/www/agent-memory.js');
const Skills = require('../app/src/main/assets/www/skills.js');

// ---------------------------------------------------------------- memory: explicit + reviewable
let tick = 1000;
const store = AgentMemory.createStore([], { now: () => tick++ });
const pref = store.add({ kind: 'preference', text: 'I prefer short answers in Hindi', source: 'user' });
assert.strictEqual(pref.status, 'active', 'user entries are active at once');
const suggested = store.add({ kind: 'fact', text: 'The project uses Postgres', source: 'agent' });
assert.strictEqual(suggested.status, 'pending', 'agent suggestions wait for approval');
let block = store.promptBlock();
assert.ok(block.includes('I prefer short answers in Hindi'), 'active entry reaches the prompt');
assert.ok(!block.includes('Postgres'), 'pending entry stays out of the prompt');
store.approve(suggested.id);
block = store.promptBlock();
assert.ok(block.includes('Project facts') && block.includes('The project uses Postgres'), 'approved entry joins the prompt, grouped by kind');

// edit + delete + export (privacy controls)
store.update(pref.id, 'I prefer short answers');
assert.strictEqual(store.get(pref.id).text, 'I prefer short answers');
const exported = JSON.parse(store.exportJson());
assert.strictEqual(exported.length, 2, 'export contains every entry');
store.remove(suggested.id);
assert.strictEqual(store.get(suggested.id), null);
assert.ok(!store.promptBlock().includes('Postgres'), 'deleted entry leaves the prompt');
assert.throws(() => store.remove('nope'), /Unknown memory entry/);

// validation: kinds, length, secrets
assert.strictEqual(AgentMemory.validateEntry({ kind: 'secret', text: 'x' }).valid, false);
assert.throws(() => store.add({ kind: 'fact', text: 'api_key: sk-1234567890abcdef' }), /secrets/, 'secret-looking text refused');
assert.throws(() => store.add({ kind: 'fact', text: '-----BEGIN PRIVATE KEY-----' }), /secrets/);
assert.throws(() => store.add({ kind: 'fact', text: 'x'.repeat(501) }), /500/);
assert.throws(() => store.add({ kind: 'fact', text: '   ' }), /empty/);

// tool usage history is recorded and capped, and stays out of the prompt block
for (let i = 0; i < 55; i++) store.recordToolUse({ tool: 'tool-' + i, ok: i % 2 === 0 });
const usage = store.list({ kind: 'tool-usage' });
assert.strictEqual(usage.length, 50, 'tool usage capped at 50');
assert.strictEqual(usage[usage.length - 1].text, 'tool-54 ok');
assert.ok(!store.promptBlock().includes('tool-54'), 'tool usage history is not prompt text');
assert.strictEqual(store.clear('tool-usage'), 50);
assert.strictEqual(store.list().length, 1, 'clear by kind keeps other entries');

// prompt block from a persisted array (the extraPrompt path), capped
const fromArray = AgentMemory.promptBlock([{ id: 'a', kind: 'preference', text: 'Use dark mode', source: 'user', status: 'active' }]);
assert.ok(fromArray.includes('Use dark mode'));
assert.strictEqual(AgentMemory.promptBlock([]), '');
assert.strictEqual(AgentMemory.promptBlock([{ id: 'b', kind: 'nope', text: 'x' }]), '', 'invalid persisted entries are skipped, never crash the prompt');

// ---------------------------------------------------------------- skills: lifecycle + versioning
const v1 = { name: 'code-review', version: '1.0.0', description: 'Review code', body: 'Read the diff first.' };
let r = Skills.install([], v1);
assert.strictEqual(r.action, 'installed');
assert.strictEqual(r.list.length, 1);
r = Skills.install(r.list, { ...v1, version: '1.1.0', body: 'Read the diff, then run tests.' });
assert.strictEqual(r.action, 'upgraded');
assert.strictEqual(r.list[0].version, '1.1.0');
assert.throws(() => Skills.install(r.list, v1), /downgrade/, 'downgrades are refused');
r = Skills.install(r.list, { ...v1, version: '1.1.0' });
assert.strictEqual(r.action, 'unchanged');

let list = Skills.setEnabled(r.list, 'code-review', false);
assert.strictEqual(list[0].on, false);
assert.strictEqual(Skills.promptBlock(list), '', 'disabled skills stay out of the prompt');
list = Skills.setEnabled(list, 'code-review', true);
const spb = Skills.promptBlock(list);
assert.ok(spb.includes('code-review v1.1.0'), 'enabled skill listed with version');
assert.ok(/never change approvals/.test(spb), 'prompt states skills cannot bypass approvals');
list = Skills.remove(list, 'code-review');
assert.strictEqual(list.length, 0);
assert.throws(() => Skills.remove(list, 'code-review'), /Unknown skill/);

// skills cannot carry approval/permission/executable fields
for (const key of ['autoApprove', 'skipApproval', 'bypassApproval', 'permissions', 'tools', 'code', 'exec']) {
  assert.strictEqual(Skills.validateSkill({ ...v1, [key]: true }).valid, false, 'bypass field rejected: ' + key);
}
assert.strictEqual(Skills.validateSkill({ ...v1, version: 'banana' }).valid, false, 'bad semver rejected');
assert.strictEqual(Skills.validateSkill({ ...v1, name: 'Bad Name' }).valid, false, 'bad name rejected');
assert.strictEqual(Skills.validateSkill({ ...v1, body: '' }).valid, false, 'empty body rejected');

// discovery over the built-in catalogue
assert.deepStrictEqual(Skills.discover('').map((s) => s.name), ['code-review', 'test-first']);
assert.deepStrictEqual(Skills.discover('failing test').map((s) => s.name), ['test-first']);
Skills.CATALOGUE.forEach((s) => assert.strictEqual(Skills.validateSkill(s).valid, true, 'catalogue skill validates: ' + s.name));
assert.strictEqual(Skills.compareVersions('1.0.0', '2.0.0'), -1);
assert.strictEqual(Skills.compareVersions('1.0.0-beta', '1.0.0'), -1);
assert.strictEqual(Skills.compareVersions('1.0.0', '1.0.0'), 0);

console.log('MEMORY + SKILLS TESTS PASSED');
