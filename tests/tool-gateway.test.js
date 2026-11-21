'use strict';
/* Day 5 — AI Plugin Tool Gateway: declarative tool schemas with permission requirements,
   discovery for connected plugins only, user approval for write/deploy/admin actions,
   timeouts, rate limits and idempotency. The gateway authorizes; it never executes. */
const assert = require('node:assert');
const Plugins = require('../app/src/main/assets/www/plugin-registry.js');
const ToolGateway = require('../app/src/main/assets/www/tool-gateway.js');

const github = {
  id: 'github', name: 'GitHub', version: '1.0.0', description: 'Repository integration', category: 'development',
  auth: { type: 'oauth2', provider: 'github' },
  permissions: ['profile:read', 'files:read', 'issues:write', 'deploy:write'],
  installState: 'installed', connectionState: 'authorized',
  tools: [
    { id: 'list-repos', name: 'List repositories', permission: 'files:read' },
    { id: 'create-issue', name: 'Create issue', permission: 'issues:write', timeoutMs: 15000, inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    { id: 'deploy', name: 'Deploy', permission: 'deploy:write' },
    { id: 'whoami', name: 'Who am I' },
  ],
};
const notes = {
  id: 'notes', name: 'Notes', version: '1.0.0', description: 'Notes integration', category: 'productivity',
  auth: { type: 'none' }, permissions: ['profile:read'],
  installState: 'installed', connectionState: 'disconnected',
  tools: [{ id: 'read-notes', name: 'Read notes', permission: 'profile:read' }],
};
const shelf = {
  id: 'shelf', name: 'Shelf', version: '1.0.0', description: 'Shelf integration', category: 'other',
  auth: { type: 'none' }, permissions: ['profile:read'],
  tools: [{ id: 'browse', name: 'Browse', permission: 'profile:read' }],
};
const ALL = ['profile:read', 'files:read', 'issues:write', 'deploy:write'];

// ---------------------------------------------------------------- registry tool schemas
assert.strictEqual(Plugins.validate(github).valid, true, 'declarative tool schemas validate');
const clean = Plugins.normalize(github);
const byId = Object.fromEntries(clean.tools.map((t) => [t.id, t]));
assert.strictEqual(byId['list-repos'].access, 'read');
assert.strictEqual(byId['list-repos'].requiresApproval, false);
assert.strictEqual(byId['list-repos'].timeoutMs, 30000, 'default timeout applied');
assert.strictEqual(byId['create-issue'].access, 'write');
assert.strictEqual(byId['create-issue'].requiresApproval, true);
assert.strictEqual(byId['create-issue'].timeoutMs, 15000);
assert.strictEqual(byId['deploy'].access, 'admin', 'deploy:write is admin access');
assert.strictEqual(byId['whoami'].permission, null);
assert.strictEqual(Plugins.deriveAccess('messages:write'), 'write');

const withTool = (tool) => Plugins.validate({ ...github, tools: [tool] }).valid;
assert.strictEqual(withTool({ id: 'x', name: 'X', permission: 'messages:read' }), false, 'tool permission must be declared by the manifest');
assert.strictEqual(withTool({ id: 'x', name: 'X', permission: 'admin:all' }), false, 'unknown tool permission rejected');
assert.strictEqual(withTool({ id: 'x', name: 'X', permission: 'files:read', access: 'write' }), false, 'access must match permission');
assert.strictEqual(withTool({ id: 'x', name: 'X', access: 'write' }), false, 'write tools must declare a permission');
assert.strictEqual(withTool({ id: 'x', name: 'X', permission: 'files:read', timeoutMs: 50 }), false, 'timeout below range rejected');
assert.strictEqual(withTool({ id: 'x', name: 'X', permission: 'files:read', timeoutMs: 120001 }), false, 'timeout above range rejected');
assert.strictEqual(withTool({ id: 'x', name: 'X', permission: 'files:read', inputSchema: [] }), false, 'inputSchema must be an object');
assert.strictEqual(withTool({ id: 'x', name: 'X', code: 'process.exit(1)' }), false, 'executable tool fields rejected (no arbitrary code)');
assert.strictEqual(withTool({ id: 'x', name: 'X', inputSchema: { properties: { cb: { script: 'y' } } } }), false, 'nested executable keys rejected');
assert.strictEqual(withTool({ id: 'x', name: 'X', extra: () => {} }), false, 'function values rejected');

const registry = Plugins.createRegistry([github, notes, shelf]);
assert.deepStrictEqual(registry.toolsFor('github').map((t) => t.id), ['list-repos', 'create-issue', 'deploy', 'whoami']);
assert.deepStrictEqual(registry.toolsFor('nope'), []);
assert.deepStrictEqual(registry.listTools().map((t) => t.pluginId + '/' + t.id),
  ['github/create-issue', 'github/deploy', 'github/list-repos', 'github/whoami', 'shelf/browse', 'notes/read-notes'],
  'listTools is deterministic (registry plugin order category/name/id, then tool id)');

// ---------------------------------------------------------------- gateway discovery + authorization
const gateway = ToolGateway.createGateway(registry);
assert.deepStrictEqual(Object.keys(ToolGateway), ['createGateway']);
assert.deepStrictEqual(Object.keys(gateway).sort(), ['authorize', 'discover'], 'gateway exposes no execution method');

const seen = gateway.discover({ grantedPermissions: ['files:read', 'issues:write'] }).map((t) => t.pluginId + '/' + t.id);
assert.deepStrictEqual(seen, ['github/create-issue', 'github/list-repos', 'github/whoami'],
  'discovery: connected plugins only, ungranted-permission tools hidden, disconnected/uninstalled hidden');

const denied = (req, reason) => assert.throws(() => gateway.authorize(req), (e) => e.status === 403 && e.reason === reason, 'denied: ' + reason);
denied({ pluginId: 'nope', toolId: 'x', grantedPermissions: ALL }, 'unknown_plugin');
denied({ pluginId: 'shelf', toolId: 'browse', grantedPermissions: ALL }, 'not_installed');
denied({ pluginId: 'notes', toolId: 'read-notes', grantedPermissions: ALL }, 'not_connected');
denied({ pluginId: 'github', toolId: 'nope', grantedPermissions: ALL }, 'unknown_tool');
denied({ pluginId: 'github', toolId: 'list-repos', grantedPermissions: [] }, 'missing_permission');
denied({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ALL }, 'approval_required');
denied({ pluginId: 'github', toolId: 'deploy', grantedPermissions: ALL, approved: false, idempotencyKey: 'deploy-key-1' }, 'approval_required');
denied({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ALL, approved: true }, 'idempotency_key_required');
denied({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ALL, approved: true, idempotencyKey: 'short' }, 'idempotency_key_required');

const read = gateway.authorize({ pluginId: 'github', toolId: 'list-repos', grantedPermissions: ALL });
assert.deepStrictEqual({ ...read }, { pluginId: 'github', toolId: 'list-repos', permission: 'files:read', access: 'read', requiresApproval: false, timeoutMs: 30000, idempotencyKey: null, duplicate: false });

const write = gateway.authorize({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ALL, approved: true, idempotencyKey: 'issue-key-123' });
assert.strictEqual(write.access, 'write');
assert.strictEqual(write.timeoutMs, 15000, 'tool timeout carried into the invocation');
assert.strictEqual(write.duplicate, false);
const again = gateway.authorize({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ALL, approved: true, idempotencyKey: 'issue-key-123' });
assert.strictEqual(again.duplicate, true, 'repeated idempotency key returns the first invocation');
assert.strictEqual(again.timeoutMs, write.timeoutMs);

const admin = gateway.authorize({ pluginId: 'github', toolId: 'deploy', grantedPermissions: ALL, approved: true, idempotencyKey: 'deploy-key-1' });
assert.strictEqual(admin.access, 'admin');

// ---------------------------------------------------------------- rate limits (injected clock)
let t = 1000000;
const limited = ToolGateway.createGateway(registry, { now: () => t, rateLimit: { max: 2, windowMs: 60000 } });
limited.authorize({ pluginId: 'github', toolId: 'whoami', grantedPermissions: ALL });
limited.authorize({ pluginId: 'github', toolId: 'whoami', grantedPermissions: ALL });
assert.throws(() => limited.authorize({ pluginId: 'github', toolId: 'whoami', grantedPermissions: ALL }), (e) => e.reason === 'rate_limited', 'third call in the window is rate limited');
t += 60001;
assert.strictEqual(limited.authorize({ pluginId: 'github', toolId: 'whoami', grantedPermissions: ALL }).duplicate, false, 'window expiry allows calls again');

console.log('TOOL GATEWAY TESTS PASSED');
