/* CybNate plugin manifest registry. Metadata only: this module never executes plugin code. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PluginRegistry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const CATEGORIES = new Set(['development', 'cloud', 'productivity', 'research', 'ai', 'other']);
  const PERMISSIONS = new Set(['profile:read', 'files:read', 'files:write', 'issues:read', 'issues:write', 'deploy:read', 'deploy:write', 'messages:read', 'messages:write']);
  const AUTH_TYPES = new Set(['none', 'oauth2', 'api_key', 'mcp']);
  /* Day 2: install state and connection state are tracked separately.
     Installing a plugin never implies its account is connected or authorized. */
  const INSTALL_STATES = new Set(['available', 'installed', 'disabled']);
  const CONNECTION_STATES = new Set(['disconnected', 'configured', 'connected', 'authorized', 'error']);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function parseVersion(v) {
    if (typeof v !== 'string' || !VERSION.test(v)) return null;
    const dash = v.indexOf('-');
    const core = dash === -1 ? v : v.slice(0, dash);
    const pre = dash === -1 ? null : v.slice(dash + 1);
    const parts = core.split('.').map((n) => Number(n));
    return { major: parts[0], minor: parts[1], patch: parts[2], prerelease: pre };
  }
  function isStableVersion(v) { const p = parseVersion(v); return !!p && p.prerelease === null; }
  /* Returns -1, 0 or 1. A prerelease sorts before the same stable version. Invalid input returns null. */
  function compareVersions(a, b) {
    const pa = parseVersion(a); const pb = parseVersion(b);
    if (!pa || !pb) return null;
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    if (pa.prerelease === pb.prerelease) return 0;
    if (pa.prerelease === null) return 1;
    if (pb.prerelease === null) return -1;
    return pa.prerelease < pb.prerelease ? -1 : 1;
  }

  function validate(input) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['Manifest must be an object'] };
    if (typeof input.id !== 'string' || !ID.test(input.id)) errors.push('id must be a lowercase kebab-case identifier (1-64 chars)');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) errors.push('name must be 1-80 characters');
    if (typeof input.version !== 'string' || !VERSION.test(input.version)) errors.push('version must use semantic version format');
    if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 500) errors.push('description must be 1-500 characters');
    if (!CATEGORIES.has(input.category)) errors.push('category is not supported');
    if (!input.auth || typeof input.auth !== 'object' || !AUTH_TYPES.has(input.auth.type)) errors.push('auth.type must be none, oauth2, api_key or mcp');
    if (!Array.isArray(input.permissions) || input.permissions.length > 20) errors.push('permissions must be an array of at most 20 entries');
    else {
      const seen = new Set();
      input.permissions.forEach((p) => {
        if (typeof p !== 'string' || !PERMISSIONS.has(p)) errors.push('unsupported permission: ' + String(p));
        else if (seen.has(p)) errors.push('duplicate permission: ' + p);
        else seen.add(p);
      });
    }
    if (!Array.isArray(input.tools) || input.tools.length > 50) errors.push('tools must be an array of at most 50 entries');
    else {
      const seen = new Set();
      input.tools.forEach((t) => {
        if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID.test(t.id) || typeof t.name !== 'string' || !t.name.trim()) errors.push('each tool needs a valid id and name');
        else if (seen.has(t.id)) errors.push('duplicate tool id: ' + t.id);
        else seen.add(t.id);
      });
    }
    if (input.auth && input.auth.type === 'oauth2' && (typeof input.auth.provider !== 'string' || !ID.test(input.auth.provider))) errors.push('oauth2 auth requires a provider id');
    if (input.auth && input.auth.type === 'mcp' && (typeof input.auth.serverId !== 'string' || !ID.test(input.auth.serverId))) errors.push('mcp auth requires a serverId');
    /* Day 2 catalogue metadata (all optional, validated when present). */
    if (own(input, 'publisher') && input.publisher !== null && (typeof input.publisher !== 'string' || !input.publisher.trim() || input.publisher.length > 80)) errors.push('publisher must be 1-80 characters');
    if (own(input, 'official') && typeof input.official !== 'boolean') errors.push('official must be a boolean');
    if (own(input, 'pinnedVersion') && input.pinnedVersion !== null) {
      if (typeof input.pinnedVersion !== 'string' || !VERSION.test(input.pinnedVersion)) errors.push('pinnedVersion must use semantic version format');
      else if (!isStableVersion(input.pinnedVersion)) errors.push('pinnedVersion must be a stable version (no prerelease)');
      else if (typeof input.version === 'string' && VERSION.test(input.version) && input.pinnedVersion !== input.version) errors.push('pinnedVersion must match version');
    }
    if (own(input, 'compatibility') && input.compatibility !== null) {
      const c = input.compatibility;
      if (!c || typeof c !== 'object' || Array.isArray(c)) errors.push('compatibility must be an object');
      else {
        if (own(c, 'minAppVersion') && c.minAppVersion !== null && (typeof c.minAppVersion !== 'string' || !VERSION.test(c.minAppVersion))) errors.push('compatibility.minAppVersion must use semantic version format');
        if (own(c, 'maxAppVersion') && c.maxAppVersion !== null && (typeof c.maxAppVersion !== 'string' || !VERSION.test(c.maxAppVersion))) errors.push('compatibility.maxAppVersion must use semantic version format');
        if (typeof c.minAppVersion === 'string' && typeof c.maxAppVersion === 'string' && VERSION.test(c.minAppVersion) && VERSION.test(c.maxAppVersion) && compareVersions(c.minAppVersion, c.maxAppVersion) > 0) errors.push('compatibility.minAppVersion must not exceed maxAppVersion');
      }
    }
    if (own(input, 'installState') && !INSTALL_STATES.has(input.installState)) errors.push('installState must be available, installed or disabled');
    if (own(input, 'connectionState') && !CONNECTION_STATES.has(input.connectionState)) errors.push('connectionState must be disconnected, configured, connected, authorized or error');
    const installState = own(input, 'installState') ? input.installState : 'available';
    const connectionState = own(input, 'connectionState') ? input.connectionState : 'disconnected';
    if (installState !== 'installed' && connectionState !== 'disconnected' && connectionState !== 'error') errors.push('connectionState requires installState installed');
    return { valid: errors.length === 0, errors };
  }

  function normalize(input) {
    const result = validate(input);
    if (!result.valid) throw new Error('Invalid plugin manifest: ' + result.errors.join('; '));
    const compat = (input.compatibility && typeof input.compatibility === 'object') ? input.compatibility : {};
    const stable = isStableVersion(input.version);
    return Object.freeze({
      id: input.id, name: input.name.trim(), version: input.version, description: input.description.trim(),
      category: input.category, auth: Object.freeze({ type: input.auth.type, ...(input.auth.provider ? { provider: input.auth.provider } : {}), ...(input.auth.serverId ? { serverId: input.auth.serverId } : {}) }),
      permissions: Object.freeze(input.permissions.slice()), tools: Object.freeze(input.tools.map((t) => Object.freeze({ id: t.id, name: t.name.trim() }))),
      /* Day 2 fields */
      publisher: (typeof input.publisher === 'string' && input.publisher.trim()) ? input.publisher.trim() : null,
      official: input.official === true,
      stable,
      pinnedVersion: (typeof input.pinnedVersion === 'string') ? input.pinnedVersion : (stable ? input.version : null),
      compatibility: Object.freeze({
        minAppVersion: (typeof compat.minAppVersion === 'string') ? compat.minAppVersion : '0.0.0',
        maxAppVersion: (typeof compat.maxAppVersion === 'string') ? compat.maxAppVersion : null
      }),
      installState: own(input, 'installState') ? input.installState : 'available',
      connectionState: own(input, 'connectionState') ? input.connectionState : 'disconnected'
    });
  }

  /* Returns a new frozen manifest with updated lifecycle states.
     Install and connection stay separate: a plugin must be installed before it can be configured/connected/authorized. */
  function applyState(manifest, patch) {
    const clean = normalize(manifest);
    const next = { ...clean, ...(patch || {}) };
    return normalize(next);
  }

  function checkCompatibility(manifest, appVersion) {
    const clean = normalize(manifest);
    if (typeof appVersion !== 'string' || !VERSION.test(appVersion)) return { compatible: false, reasons: ['appVersion must use semantic version format'] };
    const reasons = [];
    if (compareVersions(appVersion, clean.compatibility.minAppVersion) < 0) reasons.push('requires app version >= ' + clean.compatibility.minAppVersion);
    if (clean.compatibility.maxAppVersion && compareVersions(appVersion, clean.compatibility.maxAppVersion) > 0) reasons.push('requires app version <= ' + clean.compatibility.maxAppVersion);
    return { compatible: reasons.length === 0, reasons };
  }

  function sortDeterministic(list) {
    return list.slice().sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))));
  }

  function createRegistry(manifests, options) {
    const items = new Map();
    const appVersion = options && typeof options.appVersion === 'string' ? options.appVersion : null;
    (manifests || []).forEach((m) => {
      const clean = normalize(m);
      if (items.has(clean.id)) throw new Error('Duplicate plugin id: ' + clean.id);
      if (appVersion) {
        const check = checkCompatibility(clean, appVersion);
        if (!check.compatible) throw new Error('Incompatible plugin ' + clean.id + ': ' + check.reasons.join('; '));
      }
      items.set(clean.id, clean);
    });
    const all = () => sortDeterministic(Array.from(items.values()));
    return Object.freeze({
      list: () => all(),
      get: (id) => items.get(id) || null,
      search: (query) => { const q = String(query || '').trim().toLowerCase(); return all().filter((m) => !q || (m.name + ' ' + m.description + ' ' + m.category + ' ' + (m.publisher || '')).toLowerCase().includes(q)); },
      byCategory: (category) => all().filter((m) => m.category === category),
      filter: (criteria) => {
        const c = criteria || {};
        return all().filter((m) =>
          (c.category === undefined || m.category === c.category) &&
          (c.authType === undefined || m.auth.type === c.authType) &&
          (c.installState === undefined || m.installState === c.installState) &&
          (c.connectionState === undefined || m.connectionState === c.connectionState) &&
          (c.official === undefined || m.official === c.official) &&
          (c.stableOnly !== true || m.stable) &&
          (c.query === undefined || (m.name + ' ' + m.description + ' ' + m.category + ' ' + (m.publisher || '')).toLowerCase().includes(String(c.query).trim().toLowerCase())));
      },
      compatibleWith: (version) => all().filter((m) => checkCompatibility(m, version).compatible),
      catalogue: () => all().map((m) => Object.freeze({
        id: m.id, name: m.name, version: m.version, pinnedVersion: m.pinnedVersion, stable: m.stable,
        official: m.official, publisher: m.publisher, category: m.category,
        minAppVersion: m.compatibility.minAppVersion, maxAppVersion: m.compatibility.maxAppVersion,
        installState: m.installState, connectionState: m.connectionState
      }))
    });
  }
  return Object.freeze({
    validate, normalize, createRegistry, applyState, checkCompatibility, compareVersions, parseVersion, isStableVersion,
    permissions: Object.freeze(Array.from(PERMISSIONS)), categories: Object.freeze(Array.from(CATEGORIES)),
    installStates: Object.freeze(Array.from(INSTALL_STATES)), connectionStates: Object.freeze(Array.from(CONNECTION_STATES))
  });
});
