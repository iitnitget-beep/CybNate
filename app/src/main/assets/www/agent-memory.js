/* CybNate agent memory (Day 8). Explicit, reviewable, removable memory for the agent:
 * user preferences, project facts, task outcomes and tool usage history. Entries added by
 * the user are active at once; anything suggested by the agent or the system stays pending
 * until the user approves it, and only active entries reach the agent prompt. Secrets are
 * refused: memory is for facts about the work, never for keys or passwords. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentMemory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KINDS = new Set(['preference', 'fact', 'outcome', 'tool-usage']);
  const SOURCES = new Set(['user', 'agent', 'system']);
  const STATUSES = new Set(['active', 'pending']);
  const MAX_TEXT = 500;
  const MAX_TOOL_USAGE = 50;
  const SECRET_TEXT = /(password|passwd|api[_-]?key|secret|token|private[_-]?key)\s*[:=]\s*\S{6,}/i;
  const PRIVATE_KEY = /BEGIN [A-Z ]*PRIVATE KEY/;

  function validateText(text) {
    if (typeof text !== 'string' || !text.trim()) return 'memory text must not be empty';
    if (text.length > MAX_TEXT) return 'memory text must be at most ' + MAX_TEXT + ' characters';
    if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return 'memory text must not contain control characters';
    if (SECRET_TEXT.test(text) || PRIVATE_KEY.test(text)) return 'memory must not contain secrets (keys, tokens or passwords belong in Secrets)';
    return null;
  }
  function validateEntry(input) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['memory entry must be an object'] };
    if (!KINDS.has(input.kind)) errors.push('kind must be preference, fact, outcome or tool-usage');
    if (input.source != null && !SOURCES.has(input.source)) errors.push('source must be user, agent or system');
    if (input.status != null && !STATUSES.has(input.status)) errors.push('status must be active or pending');
    const bad = validateText(input.text);
    if (bad) errors.push(bad);
    return { valid: errors.length === 0, errors };
  }

  /** A store over a plain entry array (the app persists it as settings.agentMemory). */
  function createStore(entries, options) {
    const now = options && typeof options.now === 'function' ? options.now : Date.now;
    let seq = 0;
    const idGen = options && typeof options.idGen === 'function' ? options.idGen : () => 'mem-' + now().toString(36) + '-' + (++seq).toString(36);
    const items = [];
    const clean = (e) => Object.freeze({
      id: String(e.id), kind: e.kind, text: String(e.text).trim(), source: SOURCES.has(e.source) ? e.source : 'user',
      status: STATUSES.has(e.status) ? e.status : 'active',
      createdAt: Number.isFinite(e.createdAt) ? e.createdAt : now(), updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : now(),
    });
    (entries || []).forEach((e) => { if (e && typeof e === 'object' && KINDS.has(e.kind) && !validateText(e.text)) items.push(clean(e)); });
    const find = (id) => items.find((e) => e.id === id) || null;
    const replace = (id, patch) => {
      const i = items.findIndex((e) => e.id === id);
      if (i < 0) throw new Error('Unknown memory entry: ' + String(id || ''));
      items[i] = clean(Object.assign({}, items[i], patch, { updatedAt: now() }));
      return items[i];
    };

    /** Add an entry. User entries are active immediately; agent/system suggestions wait for approval. */
    function addEntry(input) {
        const result = validateEntry(input);
        if (!result.valid) throw new Error('Invalid memory entry: ' + result.errors.join('; '));
        const source = SOURCES.has(input.source) ? input.source : 'user';
        const entry = clean({
          id: input.id || idGen(), kind: input.kind, text: input.text, source,
          status: STATUSES.has(input.status) ? input.status : (source === 'user' ? 'active' : 'pending'),
          createdAt: now(), updatedAt: now(),
        });
        if (find(entry.id)) throw new Error('Duplicate memory id: ' + entry.id);
        items.push(entry);
        return entry;
    }

    return Object.freeze({
      add: addEntry,
      approve: (id) => replace(id, { status: 'active' }),
      update(id, text) {
        const bad = validateText(text);
        if (bad) throw new Error('Invalid memory entry: ' + bad);
        return replace(id, { text });
      },
      remove(id) {
        const i = items.findIndex((e) => e.id === id);
        if (i < 0) throw new Error('Unknown memory entry: ' + String(id || ''));
        return items.splice(i, 1)[0];
      },
      clear(kind) {
        if (kind && !KINDS.has(kind)) throw new Error('kind must be preference, fact, outcome or tool-usage');
        const before = items.length;
        for (let i = items.length - 1; i >= 0; i--) if (!kind || items[i].kind === kind) items.splice(i, 1);
        return before - items.length;
      },
      list(filter) {
        const f = filter || {};
        return Object.freeze(items.filter((e) => (!f.kind || e.kind === f.kind) && (!f.status || e.status === f.status)).slice());
      },
      get: (id) => find(id),
      /** Tool usage history: capped, newest kept. */
      recordToolUse(record) {
        const r = record || {};
        const tool = String(r.tool || '').trim();
        if (!tool) throw new Error('tool name is required');
        const entry = addEntry({ kind: 'tool-usage', text: tool + (r.ok === false ? ' failed' : ' ok'), source: 'system', status: 'active' });
        const usage = items.filter((e) => e.kind === 'tool-usage');
        while (usage.length > MAX_TOOL_USAGE) { const old = usage.shift(); items.splice(items.indexOf(old), 1); }
        return entry;
      },
      /** Everything, as JSON the user can keep or move. */
      exportJson: () => JSON.stringify(items, null, 2),
      /** The block added to the agent prompt: active entries only, grouped, capped. */
      promptBlock(maxChars) {
        const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 2000;
        const active = items.filter((e) => e.status === 'active' && e.kind !== 'tool-usage');
        if (!active.length) return '';
        const label = { preference: 'Preferences', fact: 'Project facts', outcome: 'Past outcomes' };
        const lines = ['Memory (things the user has explicitly saved; treat as standing context):'];
        for (const kind of ['preference', 'fact', 'outcome']) {
          const group = active.filter((e) => e.kind === kind);
          if (!group.length) continue;
          lines.push(label[kind] + ':');
          group.forEach((e) => lines.push('- ' + e.text));
        }
        let out = lines.join('\n');
        if (out.length > cap) out = out.slice(0, cap).replace(/\n[^\n]*$/, '') + '\n…';
        return out;
      },
    });
  }

  /** Prompt block straight from a persisted entry array (what extraPrompt uses). */
  function promptBlock(entries, maxChars) {
    try { return createStore(entries || []).promptBlock(maxChars); } catch (e) { return ''; }
  }

  return Object.freeze({ validateEntry, createStore, promptBlock, kinds: Object.freeze(Array.from(KINDS)), maxText: MAX_TEXT });
});
