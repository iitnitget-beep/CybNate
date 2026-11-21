/* CybNate MCP server registry (Day 6). Registration, transport policy, explicit trust,
 * tool allowlists and connection health for MCP servers. This module never connects to or
 * executes a server: it only decides whether a server's tools may be seen or used, and the
 * actual call still runs through the Safety-gated runTools path. Remote credentials are
 * referenced by server-side secret NAME only (credentialRef); values never live here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.McpRegistry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
  const TRANSPORTS = new Set(['stdio', 'http', 'sse']);
  const TRUST_STATES = new Set(['untrusted', 'trusted']);
  const HEALTH_STATES = new Set(['unknown', 'healthy', 'unhealthy']);
  /* Fields that would carry a credential VALUE. Registrations may only name a server-side secret. */
  const CREDENTIAL_FIELDS = new Set(['token', 'apiKey', 'api_key', 'password', 'secret', 'accessToken', 'refreshToken', 'authorization']);
  const EXECUTABLE_KEYS = new Set(['code', 'script', 'eval', 'exec', 'handler', 'run']);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function deny(reason, message) {
    const e = new Error(message);
    e.status = 403;
    e.reason = reason;
    return e;
  }
  function findExecutable(value, depth) {
    if (typeof value === 'function') return 'function value';
    if (!value || typeof value !== 'object' || depth > 8) return null;
    for (const k of Object.keys(value)) {
      if (EXECUTABLE_KEYS.has(k)) return k;
      const hit = findExecutable(value[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  function validToolIds(list) {
    if (!Array.isArray(list) || list.length > 50) return false;
    const seen = new Set();
    for (const t of list) {
      if (typeof t !== 'string' || !ID.test(t) || seen.has(t)) return false;
      seen.add(t);
    }
    return true;
  }

  function validateServer(input) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['Server registration must be an object'] };
    if (typeof input.id !== 'string' || !ID.test(input.id)) errors.push('id must be a lowercase kebab-case identifier (1-64 chars)');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) errors.push('name must be 1-80 characters');
    if (!TRANSPORTS.has(input.transport)) errors.push('transport must be stdio, http or sse');
    for (const k of Object.keys(input)) {
      if (CREDENTIAL_FIELDS.has(k)) errors.push('credentials stay server-side; use credentialRef (secret name) only, not: ' + k);
    }
    const execKey = findExecutable(input, 0);
    if (execKey) errors.push('server registration must be declarative (no executable field: ' + execKey + ')');
    if (input.transport === 'stdio') {
      if (typeof input.command !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(input.command)) errors.push('stdio servers need a single program command without shell characters');
      if (own(input, 'args') && input.args !== null && (!Array.isArray(input.args) || input.args.length > 20 || input.args.some((a) => typeof a !== 'string' || a.length > 256 || /[\0\n\r]/.test(a)))) errors.push('args must be an array of at most 20 short strings');
      if (own(input, 'url') && input.url !== null) errors.push('stdio servers do not take a url');
    }
    if (input.transport === 'http' || input.transport === 'sse') {
      let url = null;
      try { url = new URL(String(input.url || '')); } catch (e) { /* handled below */ }
      if (!url) errors.push('remote servers need a valid url');
      else {
        const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) errors.push('remote server url must be https (http only for localhost)');
        if (url.username || url.password) errors.push('remote server url must not contain credentials');
      }
      if (own(input, 'command') && input.command !== null) errors.push('remote servers do not take a command');
    }
    if (own(input, 'credentialRef') && input.credentialRef !== null && (typeof input.credentialRef !== 'string' || !SECRET_NAME.test(input.credentialRef))) errors.push('credentialRef must be a server-side secret name (A-Z, digits, _)');
    if (own(input, 'allowedTools') && input.allowedTools !== null && !validToolIds(input.allowedTools)) errors.push('allowedTools must be an array of at most 50 unique tool ids');
    if (own(input, 'trust') && !TRUST_STATES.has(input.trust)) errors.push('trust must be untrusted or trusted');
    if (own(input, 'enabled') && typeof input.enabled !== 'boolean') errors.push('enabled must be a boolean');
    return { valid: errors.length === 0, errors };
  }

  function normalizeServer(input) {
    const result = validateServer(input);
    if (!result.valid) throw new Error('Invalid MCP server registration: ' + result.errors.join('; '));
    return Object.freeze({
      id: input.id, name: input.name.trim(), transport: input.transport,
      command: input.transport === 'stdio' ? input.command : null,
      args: Object.freeze(input.transport === 'stdio' && Array.isArray(input.args) ? input.args.slice() : []),
      url: input.transport === 'stdio' ? null : String(input.url),
      credentialRef: (typeof input.credentialRef === 'string') ? input.credentialRef : null,
      allowedTools: Object.freeze(Array.isArray(input.allowedTools) ? input.allowedTools.slice() : []),
      trust: TRUST_STATES.has(input.trust) ? input.trust : 'untrusted',
      enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
      health: Object.freeze({ status: 'unknown', lastCheckedAt: 0, consecutiveFailures: 0 })
    });
  }

  function createMcpRegistry(servers, options) {
    const now = options && typeof options.now === 'function' ? options.now : Date.now;
    const items = new Map();
    const snapshot = (s) => Object.freeze({
      id: s.id, name: s.name, transport: s.transport, command: s.command, args: Object.freeze(s.args.slice()),
      url: s.url, credentialRef: s.credentialRef, allowedTools: Object.freeze(s.allowedTools.slice()),
      trust: s.trust, enabled: s.enabled,
      health: Object.freeze({ status: s.health.status, lastCheckedAt: s.health.lastCheckedAt, consecutiveFailures: s.health.consecutiveFailures })
    });
    const mustGet = (id) => {
      const s = items.get(id);
      if (!s) throw deny('unknown_server', 'Unknown MCP server: ' + String(id || ''));
      return s;
    };
    function register(input) {
      const clean = normalizeServer(input);
      if (items.has(clean.id)) throw new Error('Duplicate MCP server id: ' + clean.id);
      const state = {
        id: clean.id, name: clean.name, transport: clean.transport, command: clean.command, args: clean.args.slice(),
        url: clean.url, credentialRef: clean.credentialRef, allowedTools: clean.allowedTools.slice(),
        trust: clean.trust, enabled: clean.enabled,
        health: { status: 'unknown', lastCheckedAt: 0, consecutiveFailures: 0 }
      };
      items.set(state.id, state);
      return snapshot(state);
    }
    (servers || []).forEach(register);

    return Object.freeze({
      register,
      get: (id) => { const s = items.get(id); return s ? snapshot(s) : null; },
      list: () => Object.freeze(Array.from(items.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(snapshot)),
      /* Explicit trust: a server starts untrusted and only a deliberate trust() makes its tools usable. */
      trust: (id) => { const s = mustGet(id); s.trust = 'trusted'; return snapshot(s); },
      revoke: (id) => { const s = mustGet(id); s.trust = 'untrusted'; return snapshot(s); },
      disable: (id) => { const s = mustGet(id); s.enabled = false; return snapshot(s); },
      enable: (id) => { const s = mustGet(id); s.enabled = true; return snapshot(s); },
      setAllowlist: (id, tools) => {
        const s = mustGet(id);
        if (!validToolIds(tools)) throw new Error('allowedTools must be an array of at most 50 unique tool ids');
        s.allowedTools = tools.slice();
        return snapshot(s);
      },
      recordHealth: (id, ok, at) => {
        const s = mustGet(id);
        s.health = {
          status: ok ? 'healthy' : 'unhealthy',
          lastCheckedAt: Number.isFinite(at) ? at : now(),
          consecutiveFailures: ok ? 0 : s.health.consecutiveFailures + 1
        };
        return snapshot(s);
      },
      /** Offered tools that may be shown: trusted + enabled + not unhealthy, intersected with the allowlist. */
      visibleTools: (id, offeredTools) => {
        const s = items.get(id);
        if (!s || s.trust !== 'trusted' || !s.enabled || s.health.status === 'unhealthy') return Object.freeze([]);
        const offered = new Set((Array.isArray(offeredTools) ? offeredTools : []).filter((t) => typeof t === 'string' && ID.test(t)));
        return Object.freeze(s.allowedTools.filter((t) => offered.has(t)).sort());
      },
      /** Gate for one tool call. Throws 403 with a reason; untrusted servers cannot bypass it. */
      checkTool: (id, toolId) => {
        const s = mustGet(id);
        if (!s.enabled) throw deny('disabled', 'MCP server is disabled: ' + s.id);
        if (s.trust !== 'trusted') throw deny('untrusted', 'MCP server is not trusted: ' + s.id);
        if (s.health.status === 'unhealthy') throw deny('unhealthy', 'MCP server is unhealthy: ' + s.id);
        if (!s.allowedTools.includes(toolId)) throw deny('not_allowlisted', 'Tool is not on the allowlist for ' + s.id + ': ' + String(toolId || ''));
        return true;
      }
    });
  }

  return Object.freeze({
    validateServer, normalizeServer, createMcpRegistry,
    transports: Object.freeze(Array.from(TRANSPORTS)),
    trustStates: Object.freeze(Array.from(TRUST_STATES)),
    healthStates: Object.freeze(Array.from(HEALTH_STATES))
  });
});
