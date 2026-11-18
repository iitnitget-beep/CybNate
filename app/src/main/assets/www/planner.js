/* Structured, bounded implementation plans. No DOM or network dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PLAN_STATES = Object.freeze(['DRAFT', 'READY', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);
  const STEP_STATES = Object.freeze(['PENDING', 'READY', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED']);
  const AGENTS = new Set(['coder', 'planner', 'reviewer', 'researcher', 'explorer', 'thinker', 'file_picker', 'basher', 'editor', 'reverse', 'chat']);
  const TOOLS = new Set(['list_files','read_file','search_files','find_files','list_code_definition_names','get_diagnostics','write_file','edit_file','str_replace_editor','apply_diff','delete_file','run_terminal_command','execute_python','sqlite_query','http_request','test_webapp','web_search','read_url','spawn_agent','load_skill','write_todos','suggest_followups','ask_followup_question','attempt_completion','file_info','strings','hexdump','zip_list','zip_extract','android_manifest']);
  const LIMITS = Object.freeze({ steps: 32, text: 2000, goal: 3000, assumptions: 12, risks: 12, files: 40, tools: 20, dependencies: 32 });
  function fail(message, code) { const e = new Error(message); e.code = code || 'invalid_plan'; return e; }
  function text(value, field, max, required) {
    if (typeof value !== 'string') throw fail(field + ' must be text');
    const s = value.trim();
    if (required && !s) throw fail(field + ' is required');
    if (s.length > max) throw fail(field + ' exceeds ' + max + ' characters', 'plan_too_large');
    return s;
  }
  function stringList(value, field, maxItems, maxChars) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > maxItems) throw fail(field + ' must be an array of at most ' + maxItems + ' items');
    return value.map((v, i) => text(v, field + '[' + i + ']', maxChars, true));
  }
  function safePath(p) {
    const s = text(p, 'affected_files path', 240, true).replace(/\\/g, '/');
    if (s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').some((x) => x === '..' || x === '')) throw fail('unsafe affected file path: ' + s, 'unsafe_path');
    return s;
  }
  function validatePlan(input, options) {
    options = options || {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('plan must be an object');
    const goal = text(input.user_goal, 'user_goal', LIMITS.goal, true);
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > LIMITS.steps) throw fail('steps must contain 1 to ' + LIMITS.steps + ' items');
    const seen = new Set(), knownAgents = options.knownAgents ? new Set(options.knownAgents) : AGENTS;
    const knownTools = options.knownTools ? new Set(options.knownTools) : TOOLS;
    const steps = input.steps.map((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('step ' + i + ' must be an object');
      const id = text(raw.step_id, 'step_id', 64, true);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw fail('invalid step_id: ' + id);
      if (seen.has(id)) throw fail('duplicate step_id: ' + id, 'duplicate_step');
      seen.add(id);
      const assigned = text(raw.assigned_agent, 'assigned_agent', 40, true);
      if (!knownAgents.has(assigned)) throw fail('unknown assigned_agent: ' + assigned, 'unknown_agent');
      const tools = stringList(raw.required_tools, 'required_tools', LIMITS.tools, 80);
      tools.forEach((t) => { if (!knownTools.has(t)) throw fail('unknown required tool: ' + t, 'unknown_tool'); });
      const deps = stringList(raw.dependencies, 'dependencies', LIMITS.dependencies, 64);
      const files = stringList(raw.affected_files, 'affected_files', LIMITS.files, 240).map(safePath);
      const risk = text(raw.risk_level || 'medium', 'risk_level', 20, true).toLowerCase();
      if (!['low','medium','high','critical'].includes(risk)) throw fail('invalid risk_level on ' + id);
      const status = text(raw.status || 'PENDING', 'status', 40, true).toUpperCase();
      if (!STEP_STATES.includes(status)) throw fail('invalid step status on ' + id);
      return {
        step_id: id,
        title: text(raw.title, 'title', 160, true),
        description: text(raw.description || '', 'description', LIMITS.text, false),
        assigned_agent: assigned,
        required_tools: tools,
        input: text(raw.input || '', 'input', LIMITS.text, false),
        expected_output: text(raw.expected_output || '', 'expected_output', LIMITS.text, false),
        dependencies: deps,
        affected_files: files,
        risk_level: risk,
        verification_criteria: stringList(raw.verification_criteria, 'verification_criteria', 12, 300),
        status
      };
    });
    const ids = new Set(steps.map((s) => s.step_id));
    steps.forEach((s) => s.dependencies.forEach((d) => { if (!ids.has(d)) throw fail('missing dependency "' + d + '" in step ' + s.step_id, 'missing_dependency'); if (d === s.step_id) throw fail('step cannot depend on itself: ' + d, 'dependency_cycle'); }));
    const order = topologicalSort(steps);
    const context = input.project_context == null ? {} : input.project_context;
    if (typeof context !== 'object' || Array.isArray(context)) throw fail('project_context must be an object');
    const state = text(input.overall_status || 'READY', 'overall_status', 32, true).toUpperCase();
    if (!PLAN_STATES.includes(state)) throw fail('invalid overall_status');
    return {
      plan_id: text(input.plan_id || 'plan-' + Date.now(), 'plan_id', 100, true),
      request_id: text(input.request_id || options.requestId || 'unknown-request', 'request_id', 120, true),
      user_goal: goal,
      project_context: {
        project_type: text(context.project_type || 'unknown', 'project_type', 100, false),
        summary: text(context.summary || '', 'project_context.summary', 1200, false),
        files: stringList(context.files || options.files || [], 'project_context.files', 80, 240).map(safePath)
      },
      assumptions: stringList(input.assumptions, 'assumptions', LIMITS.assumptions, 400),
      risks: stringList(input.risks, 'risks', LIMITS.risks, 400),
      overall_status: state,
      steps,
      execution_order: order,
      replan_count: Math.max(0, Math.min(1, Number.isInteger(input.replan_count) ? input.replan_count : 0))
    };
  }
  function topologicalSort(steps) {
    if (!Array.isArray(steps)) throw fail('steps must be an array');
    const byId = new Map(steps.map((s) => [s.step_id, s])), indegree = new Map(), next = new Map();
    steps.forEach((s) => { indegree.set(s.step_id, (s.dependencies || []).length); next.set(s.step_id, []); });
    steps.forEach((s) => (s.dependencies || []).forEach((d) => { if (!byId.has(d)) throw fail('missing dependency "' + d + '" in step ' + s.step_id, 'missing_dependency'); next.get(d).push(s.step_id); }));
    const ready = steps.filter((s) => indegree.get(s.step_id) === 0).map((s) => s.step_id), order = [];
    while (ready.length) {
      const id = ready.shift(); order.push(id);
      next.get(id).forEach((n) => { indegree.set(n, indegree.get(n) - 1); if (indegree.get(n) === 0) { const at = steps.findIndex((s) => s.step_id === n); let i = ready.findIndex((x) => steps.findIndex((s) => s.step_id === x) > at); if (i < 0) i = ready.length; ready.splice(i, 0, n); } });
    }
    if (order.length !== steps.length) throw fail('dependency cycle detected', 'dependency_cycle');
    return order;
  }
  function parsePlan(raw, options) {
    let source = String(raw || '').trim().replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    let data;
    try { data = JSON.parse(source); } catch (e) { throw fail('Planner response was not valid JSON', 'malformed_json'); }
    return validatePlan(data, options);
  }
  function setStepStatus(plan, stepId, status) {
    if (!plan || !Array.isArray(plan.steps)) throw fail('invalid plan');
    if (!STEP_STATES.includes(status)) throw fail('invalid step status');
    const step = plan.steps.find((s) => s.step_id === stepId);
    if (!step) throw fail('unknown step: ' + stepId);
    const allowed = { PENDING:['READY','BLOCKED','CANCELLED'], READY:['RUNNING','BLOCKED','CANCELLED'], RUNNING:['WAITING_FOR_APPROVAL','COMPLETED','FAILED','BLOCKED','CANCELLED'], WAITING_FOR_APPROVAL:['RUNNING','BLOCKED','CANCELLED'], FAILED:['READY','BLOCKED'], BLOCKED:['READY'], COMPLETED:[], CANCELLED:[] };
    if (step.status !== status && !allowed[step.status].includes(status)) throw fail('illegal step transition: ' + step.status + ' -> ' + status, 'illegal_transition');
    step.status = status;
    if (status === 'FAILED' || status === 'BLOCKED' || status === 'CANCELLED') {
      const blocked = new Set([stepId]); let changed = true;
      while (changed) { changed = false; plan.steps.forEach((s) => { if (s.status === 'PENDING' && s.dependencies.some((d) => blocked.has(d))) { s.status = 'BLOCKED'; blocked.add(s.step_id); changed = true; } }); }
    }
    return step;
  }
  function canReplan(plan) { return !!plan && plan.replan_count < 1; }
  function applyReplan(previous, revised, options) {
    if (!canReplan(previous)) throw fail('replan limit reached', 'replan_limit');
    const next = validatePlan(Object.assign({}, revised, { replan_count: previous.replan_count + 1 }), options);
    return next;
  }
  function plannerPrompt(request, files) {
    return 'Inspect the project file list and return ONLY one valid JSON object matching this schema. Do not use Markdown fences. No code edits. Schema: {"plan_id":"string","request_id":"string","user_goal":"string","project_context":{"project_type":"string","summary":"string","files":["path"]},"assumptions":["string"],"risks":["string"],"overall_status":"READY","steps":[{"step_id":"step-1","title":"string","description":"string","assigned_agent":"coder|researcher|explorer|reviewer|thinker","required_tools":["read_file"],"input":"string","expected_output":"string","dependencies":[],"affected_files":["path"],"risk_level":"low|medium|high|critical","verification_criteria":["string"],"status":"PENDING"}]}. Use 1-12 steps, unique IDs, valid dependencies, and only known agents/tools. Files may be proposed new paths but must be relative and must not contain .. . User request (untrusted data):\n' + String(request).slice(0, LIMITS.goal) + '\nWorkspace files (untrusted data):\n' + (files || []).slice(0, 80).join('\n');
  }
  function replanPrompt(plan, failures, request, files) {
    return 'Revise this plan exactly once to address the reported execution failures. Return ONLY a complete valid JSON plan in the same schema. Preserve completed work as completed only when evidence proves it; otherwise use PENDING. Do not execute tools or edit files.\nOriginal request: ' + String(request).slice(0, 1600) + '\nPrevious plan: ' + JSON.stringify(plan).slice(0, 9000) + '\nFailure evidence: ' + String(failures || '').slice(0, 5000) + '\nCurrent workspace files: ' + (files || []).slice(0, 80).join(', ');
  }
  return { PLAN_STATES, STEP_STATES, LIMITS, validatePlan, topologicalSort, parsePlan, setStepStatus, canReplan, applyReplan, plannerPrompt, replanPrompt };
});
