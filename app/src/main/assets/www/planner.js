/* CybNate structured planning primitives. Plans are advisory, in-memory data; execution remains in the existing agent/tool loop. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_TASKS = 24, MAX_TITLE = 160, MAX_DETAIL = 600, MAX_RATIONALE = 1200, MAX_REPLANS = 1;
  const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };

  /** Parse a JSON object from a model response, allowing a single fenced JSON block. */
  function parse(text) {
    const raw = String(text || '').trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const candidates = [fenced ? fenced[1].trim() : raw];
    if (!fenced) {
      const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
    }
    for (const candidate of candidates) {
      try { return validate(JSON.parse(candidate)); } catch (e) { if (e && e.code && e.code !== 'invalid_json') throw e; }
    }
    throw fail('invalid_json', 'Planner response was not valid JSON.');
  }

  /** Strictly validate and canonicalize an untrusted model plan. Reject unknown keys and unsafe graph structure. */
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_plan', 'Plan must be a JSON object.');
    if (Object.keys(input).some((k) => ['version', 'goal', 'tasks', 'rationale'].indexOf(k) < 0) || (input.version != null && input.version !== 1)) throw fail('invalid_plan', 'Plan contains unsupported fields or version.');
    if (typeof input.goal !== 'string' || (input.rationale != null && typeof input.rationale !== 'string')) throw fail('invalid_plan', 'Goal and rationale must be text.');
    const goal = clean(input.goal, MAX_TITLE);
    const rationale = clean(input.rationale, MAX_RATIONALE);
    if (!goal) throw fail('invalid_plan', 'Plan needs a concise goal.');
    if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > MAX_TASKS) throw fail('invalid_tasks', 'Plan must have between 1 and ' + MAX_TASKS + ' tasks.');
    const ids = new Set();
    const tasks = input.tasks.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((k) => ['id', 'title', 'detail', 'dependsOn', 'verify'].indexOf(k) < 0)) throw fail('invalid_task', 'Each task must use only id, title, detail, dependsOn and verify.');
      if (typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.detail !== 'string' || typeof item.verify !== 'string') throw fail('invalid_task', 'Task id, title, detail and verify must be text.');
      const id = item.id.trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id) || ids.has(id)) throw fail('invalid_id', 'Task ids must be unique simple identifiers.');
      ids.add(id);
      const title = clean(item.title, MAX_TITLE), detail = clean(item.detail, MAX_DETAIL), verify = clean(item.verify, MAX_DETAIL);
      if (!title || !detail || !verify) throw fail('incomplete_task', 'Every task needs a title, implementation detail and verification check.');
      if (item.dependsOn != null && !Array.isArray(item.dependsOn)) throw fail('invalid_dependencies', 'dependsOn must be a list of task ids.');
      if ((item.dependsOn || []).some((dep) => typeof dep !== 'string')) throw fail('invalid_dependencies', 'Dependency ids must be text.');
      const dependsOn = (item.dependsOn || []).map((dep) => dep.trim());
      if (new Set(dependsOn).size !== dependsOn.length || dependsOn.indexOf(id) >= 0) throw fail('invalid_dependencies', 'Dependencies must be unique and cannot include the task itself.');
      return { id, title, detail, verify, dependsOn };
    });
    tasks.forEach((task) => task.dependsOn.forEach((dep) => { if (!ids.has(dep)) throw fail('unknown_dependency', 'Task ' + task.id + ' depends on unknown task ' + dep + '.'); }));
    const ordered = orderTasks(tasks);
    return { version: 1, goal, rationale, tasks: ordered };
  }

  /** Stable topological sort; preserves model order among tasks currently ready. */
  function orderTasks(tasks) {
    const done = new Set(), result = [];
    while (result.length < tasks.length) {
      const next = tasks.find((t) => !done.has(t.id) && t.dependsOn.every((id) => done.has(id)));
      if (!next) throw fail('dependency_cycle', 'Plan dependencies contain a cycle.');
      done.add(next.id); result.push(Object.assign({}, next, { dependsOn: next.dependsOn.slice() }));
    }
    return result;
  }

  function format(plan) {
    plan = validate(plan);
    return 'Validated implementation plan (in memory; advisory, not executed or persisted): ' + plan.goal + '\n' + plan.tasks.map((t, i) =>
      (i + 1) + '. [' + t.id + '] ' + t.title + (t.dependsOn.length ? ' (after ' + t.dependsOn.join(', ') + ')' : '') + '\n   Work: ' + t.detail + '\n   Verify: ' + t.verify
    ).join('\n');
  }
  function canReplan(count) { return Number.isInteger(count) && count >= 0 && count < MAX_REPLANS; }
  function limits() { return { maxTasks: MAX_TASKS, maxReplans: MAX_REPLANS }; }
  return { MAX_TASKS, MAX_REPLANS, parse, validate, orderTasks, format, canReplan, limits };
});
