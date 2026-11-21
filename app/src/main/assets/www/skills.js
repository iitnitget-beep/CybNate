/* CybNate skills lifecycle (Day 8). A skill is a named set of instructions the agent loads
 * when a task matches. This module owns discovery, installation with version rules,
 * enable/disable and removal over the app's skill entries ({name, description, body, source, on}).
 * Skills are guidance only: they cannot grant approvals, widen permissions or skip safety
 * checks, and any field that tries to is rejected at install time. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Skills = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
  const MAX_BODY = 20000;
  /* Fields that would let a skill change how approvals work. Skills never carry these. */
  const BYPASS_KEYS = new Set(['autoApprove', 'auto_approve', 'skipApproval', 'skip_approval', 'bypassApproval', 'approveAll', 'noApproval', 'permissions', 'tools', 'code', 'script', 'eval', 'exec', 'handler', 'run']);

  const CATALOGUE = Object.freeze([
    Object.freeze({
      name: 'code-review', version: '1.0.0', description: 'Review changed code for bugs, edge cases and missing tests before finishing',
      body: 'When reviewing code: read the full diff first, then check each change for correctness, error handling, edge cases (empty input, large input, failure paths) and missing tests. Report findings as a short list with file and line. Do not rewrite working code for style alone.',
      source: 'built-in',
    }),
    Object.freeze({
      name: 'test-first', version: '1.0.0', description: 'Write or update a failing test before changing behaviour, then make it pass',
      body: 'For any behaviour change: first add or update a test that fails for the right reason, run it to confirm the failure, then make the smallest change that passes it, and run the full test suite. Report the test names and results when done.',
      source: 'built-in',
    }),
  ]);

  function compareVersions(a, b) {
    const pa = String(a).split('-')[0].split('.').map(Number), pb = String(b).split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }
    const preA = String(a).includes('-'), preB = String(b).includes('-');
    if (preA === preB) return 0;
    return preA ? -1 : 1; // a prerelease sorts before its release
  }

  function validateSkill(input) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['skill must be an object'] };
    for (const k of Object.keys(input)) if (BYPASS_KEYS.has(k)) errors.push('skills cannot carry approval or permission fields: ' + k);
    if (typeof input.name !== 'string' || !NAME.test(input.name)) errors.push('name must be a lowercase kebab-case identifier (1-64 chars)');
    if (input.version != null && (typeof input.version !== 'string' || !SEMVER.test(input.version))) errors.push('version must be semver (e.g. 1.0.0)');
    if (typeof input.description !== 'string' || input.description.length > 300) errors.push('description must be at most 300 characters');
    if (typeof input.body !== 'string' || !input.body.trim()) errors.push('body (instructions) must not be empty');
    if (typeof input.body === 'string' && input.body.length > MAX_BODY) errors.push('body must be at most ' + MAX_BODY + ' characters');
    if (input.on != null && typeof input.on !== 'boolean') errors.push('on must be a boolean');
    return { valid: errors.length === 0, errors };
  }
  function normalizeSkill(input) {
    const result = validateSkill(input);
    if (!result.valid) throw new Error('Invalid skill: ' + result.errors.join('; '));
    return Object.freeze({
      name: input.name, version: input.version || '1.0.0', description: String(input.description || '').trim(),
      body: input.body.slice(0, MAX_BODY), source: String(input.source || ''), on: input.on !== false,
    });
  }

  /** Install or upgrade. Returns {list, action} where action is installed | upgraded | unchanged. Downgrades are refused. */
  function install(list, input) {
    const skill = normalizeSkill(input);
    const next = (list || []).slice();
    const i = next.findIndex((x) => x.name === skill.name);
    if (i < 0) { next.push(skill); return Object.freeze({ list: Object.freeze(next), action: 'installed', skill }); }
    const cmp = compareVersions(skill.version, next[i].version || '1.0.0');
    if (cmp < 0) throw new Error('Refusing to downgrade skill ' + skill.name + ' from ' + (next[i].version || '1.0.0') + ' to ' + skill.version);
    next[i] = skill;
    return Object.freeze({ list: Object.freeze(next), action: cmp > 0 ? 'upgraded' : 'unchanged', skill });
  }
  function setEnabled(list, name, on) {
    const next = (list || []).slice();
    const i = next.findIndex((x) => x.name === name);
    if (i < 0) throw new Error('Unknown skill: ' + String(name || ''));
    next[i] = normalizeSkill(Object.assign({}, next[i], { on: !!on }));
    return Object.freeze(next);
  }
  function remove(list, name) {
    const next = (list || []).filter((x) => x.name !== name);
    if (next.length === (list || []).length) throw new Error('Unknown skill: ' + String(name || ''));
    return Object.freeze(next);
  }
  /** Discovery over a catalogue (built-in by default): name/description search, deterministic order. */
  function discover(query, catalogue) {
    const q = String(query || '').trim().toLowerCase();
    return Object.freeze((catalogue || CATALOGUE)
      .filter((s) => !q || (s.name + ' ' + s.description).toLowerCase().indexOf(q) >= 0)
      .slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }
  /** Prompt text for enabled skills. The approvals note is part of the contract: skills guide, they never authorize. */
  function promptBlock(list) {
    const enabled = (list || []).filter((s) => s && s.on !== false);
    if (!enabled.length) return '';
    const lines = ['Skills (user-installed guidance; load one with load_skill when a task matches. Skills never change approvals: every tool call still needs the user\'s approval where the app requires it):'];
    enabled.forEach((s) => lines.push('- ' + s.name + ' v' + (s.version || '1.0.0') + ': ' + String(s.description || '').slice(0, 300)));
    return lines.join('\n');
  }

  return Object.freeze({ CATALOGUE, validateSkill, normalizeSkill, compareVersions, install, setEnabled, remove, discover, promptBlock });
});
