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
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
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
    return { valid: errors.length === 0, errors };
  }
  function normalize(input) {
    const result = validate(input);
    if (!result.valid) throw new Error('Invalid plugin manifest: ' + result.errors.join('; '));
    return Object.freeze({
      id: input.id, name: input.name.trim(), version: input.version, description: input.description.trim(),
      category: input.category, auth: Object.freeze({ type: input.auth.type, ...(input.auth.provider ? { provider: input.auth.provider } : {}), ...(input.auth.serverId ? { serverId: input.auth.serverId } : {}) }),
      permissions: Object.freeze(input.permissions.slice()), tools: Object.freeze(input.tools.map((t) => Object.freeze({ id: t.id, name: t.name.trim() })))
    });
  }
  function createRegistry(manifests) {
    const items = new Map();
    (manifests || []).forEach((m) => { const clean = normalize(m); if (items.has(clean.id)) throw new Error('Duplicate plugin id: ' + clean.id); items.set(clean.id, clean); });
    return Object.freeze({
      list: () => Array.from(items.values()),
      get: (id) => items.get(id) || null,
      search: (query) => { const q = String(query || '').trim().toLowerCase(); return Array.from(items.values()).filter((m) => !q || (m.name + ' ' + m.description + ' ' + m.category).toLowerCase().includes(q)); }
    });
  }
  return Object.freeze({ validate, normalize, createRegistry, permissions: Object.freeze(Array.from(PERMISSIONS)), categories: Object.freeze(Array.from(CATEGORIES)) });
});
