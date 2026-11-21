/* CybNate AI Plugin Tool Gateway (Day 5). Permission-checked discovery and authorization for
 * declarative plugin tools. This module never executes anything: authorize() only returns an
 * invocation descriptor, and the caller must still run it through the Safety-gated runTools path. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ToolGateway = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONNECTED_STATES = new Set(['connected', 'authorized']);

  function deny(reason, message) {
    const e = new Error(message);
    e.status = 403;
    e.reason = reason;
    return e;
  }

  function createGateway(registry, options) {
    if (!registry || typeof registry.listTools !== 'function' || typeof registry.get !== 'function') throw new Error('createGateway needs a plugin registry');
    const opts = options || {};
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const rate = opts.rateLimit || {};
    const rateMax = Number.isInteger(rate.max) && rate.max > 0 ? rate.max : 60;
    const rateWindowMs = Number.isInteger(rate.windowMs) && rate.windowMs > 0 ? rate.windowMs : 60000;
    const buckets = new Map(); // "plugin:tool" -> recent authorize timestamps
    const seenKeys = new Map(); // "plugin:tool:key" -> first invocation (idempotency)

    const grantedSet = (granted) => new Set(Array.isArray(granted) ? granted : []);
    const usable = (m) => !!m && m.installState === 'installed' && CONNECTED_STATES.has(m.connectionState);

    /** Tools the user may see: installed + connected plugins only, and only tools whose permission was granted. */
    function discover(request) {
      const granted = grantedSet(request && request.grantedPermissions);
      return registry.listTools().filter((t) => {
        if (!usable(registry.get(t.pluginId))) return false;
        if (t.permission && !granted.has(t.permission)) return false;
        return true;
      });
    }

    /**
     * Authorize one tool call and return its invocation descriptor.
     * Write/admin tools need explicit user approval (approved === true) and an idempotency key;
     * a repeated key returns the first invocation flagged duplicate instead of authorizing twice.
     */
    function authorize(request) {
      const req = request || {};
      const manifest = registry.get(req.pluginId);
      if (!manifest) throw deny('unknown_plugin', 'Unknown plugin: ' + String(req.pluginId || ''));
      if (manifest.installState !== 'installed') throw deny('not_installed', 'Plugin is not installed: ' + manifest.id);
      if (!CONNECTED_STATES.has(manifest.connectionState)) throw deny('not_connected', 'Plugin is not connected: ' + manifest.id);
      const tool = manifest.tools.find((t) => t.id === req.toolId);
      if (!tool) throw deny('unknown_tool', 'Unknown tool ' + String(req.toolId || '') + ' for plugin ' + manifest.id);
      const granted = grantedSet(req.grantedPermissions);
      if (tool.permission && !granted.has(tool.permission)) throw deny('missing_permission', 'Permission not granted for ' + manifest.id + '/' + tool.id + ': ' + tool.permission);
      if (tool.requiresApproval && req.approved !== true) throw deny('approval_required', 'User approval is required for ' + tool.access + ' tool ' + manifest.id + '/' + tool.id);

      let idempotencyKey = null;
      if (tool.access !== 'read') {
        idempotencyKey = typeof req.idempotencyKey === 'string' ? req.idempotencyKey.trim() : '';
        if (idempotencyKey.length < 8 || idempotencyKey.length > 120) throw deny('idempotency_key_required', 'Write/admin tools need an idempotency key (8-120 characters): ' + manifest.id + '/' + tool.id);
        const seenId = manifest.id + ':' + tool.id + ':' + idempotencyKey;
        if (seenKeys.has(seenId)) return Object.freeze({ ...seenKeys.get(seenId), duplicate: true });
      }

      const bucketId = manifest.id + ':' + tool.id;
      const tNow = now();
      const recent = (buckets.get(bucketId) || []).filter((ts) => tNow - ts < rateWindowMs);
      if (recent.length >= rateMax) throw deny('rate_limited', 'Too many calls to ' + manifest.id + '/' + tool.id + '. Wait and retry.');
      recent.push(tNow);
      buckets.set(bucketId, recent);

      const invocation = Object.freeze({
        pluginId: manifest.id, toolId: tool.id, permission: tool.permission, access: tool.access,
        requiresApproval: tool.requiresApproval, timeoutMs: tool.timeoutMs, idempotencyKey, duplicate: false
      });
      if (idempotencyKey) seenKeys.set(manifest.id + ':' + tool.id + ':' + idempotencyKey, invocation);
      return invocation;
    }

    return Object.freeze({ discover, authorize });
  }

  return Object.freeze({ createGateway });
});
