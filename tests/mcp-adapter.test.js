'use strict';
/* Day 6 — MCP adapter: server registration + transport policy, explicit trust and tool
   allowlists, remote credentials referenced by server-side secret name only, connection
   health and disable/revoke, and fail-closed gateway integration (only approved tools
   visible; untrusted servers cannot bypass permissions). No server is ever contacted. */
const assert = require('node:assert');
const Plugins = require('../app/src/main/assets/www/plugin-registry.js');
const ToolGateway = require('../app/src/main/assets/www/tool-gateway.js');
const Mcp = require('../app/src/main/assets/www/mcp-registry.js');

const remote = { id: 'memory-server', name: 'Memory Server', transport: 'http', url: 'https://mcp.example.test/mcp', credentialRef: 'MEMORY_MCP_TOKEN', allowedTools: ['recall', 'remember'] };
const ALL = ['profile:read', 'messages:write'];

// ---------------------------------------------------------------- registration + transport policy
assert.strictEqual(Mcp.validateServer(remote).valid, true, 'remote https registration validates');
assert.strictEqual(Mcp.validateServer({ id: 'local-tools', name: 'Local', transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp-server'] }).valid, true, 'stdio registration validates');
assert.strictEqual(Mcp.validateServer({ ...remote, url: 'http://localhost:8080/mcp' }).valid, true, 'http allowed for localhost only');
const bad = (patch, why) => assert.strictEqual(Mcp.validateServer({ ...remote, ...patch }).valid, false, why);
bad({ id: '../evil' }, 'bad id rejected');
bad({ transport: 'websocket' }, 'unknown transport rejected');
bad({ url: 'http://mcp.example.test/mcp' }, 'plain http remote rejected');
bad({ url: 'https://user:pass@mcp.example.test/mcp' }, 'credentials in url rejected');
bad({ token: 'sk-live-123' }, 'credential values rejected (server-side only)');
bad({ apiKey: 'sk-live-123' }, 'apiKey values rejected');
bad({ credentialRef: 'lowercase-name' }, 'credentialRef must be a secret NAME');
bad({ allowedTools: ['recall', 'recall'] }, 'duplicate allowlist tools rejected');
bad({ allowedTools: ['Bad Tool'] }, 'allowlist tool ids must be kebab-case');
bad({ command: 'npx' }, 'remote servers do not take a command');
assert.strictEqual(Mcp.validateServer({ id: 'local-tools', name: 'Local', transport: 'stdio', command: 'npx; rm -rf /' }).valid, false, 'stdio shell characters rejected');
assert.strictEqual(Mcp.validateServer({ id: 'local-tools', name: 'Local', transport: 'stdio' }).valid, false, 'stdio needs a command');
assert.strictEqual(Mcp.validateServer({ id: 'local-tools', name: 'Local', transport: 'stdio', command: 'node', url: 'https://x.test' }).valid, false, 'stdio takes no url');

const clean = Mcp.normalizeServer(remote);
assert.strictEqual(clean.trust, 'untrusted', 'servers start untrusted');
assert.strictEqual(clean.enabled, true);
assert.strictEqual(clean.health.status, 'unknown');
assert.strictEqual(clean.credentialRef, 'MEMORY_MCP_TOKEN');
assert.ok(!JSON.stringify(clean).includes('sk-live'), 'normalized registration carries no credential values');

// ---------------------------------------------------------------- trust, allowlist, health, disable/revoke
const servers = Mcp.createMcpRegistry([remote], { now: () => 5000 });
assert.throws(() => servers.register(remote), /Duplicate MCP server id/);
const denied = (fn, reason) => assert.throws(fn, (e) => e.status === 403 && e.reason === reason, 'denied: ' + reason);
denied(() => servers.checkTool('nope', 'recall'), 'unknown_server');
denied(() => servers.checkTool('memory-server', 'recall'), 'untrusted');
assert.deepStrictEqual(servers.visibleTools('memory-server', ['recall', 'remember', 'wipe']), [], 'untrusted server shows no tools');

servers.trust('memory-server');
assert.strictEqual(servers.checkTool('memory-server', 'recall'), true, 'trusted + allowlisted tool passes');
denied(() => servers.checkTool('memory-server', 'wipe'), 'not_allowlisted');
assert.deepStrictEqual(servers.visibleTools('memory-server', ['wipe', 'remember', 'recall']), ['recall', 'remember'], 'only approved (allowlisted) tools visible');

servers.setAllowlist('memory-server', ['recall']);
denied(() => servers.checkTool('memory-server', 'remember'), 'not_allowlisted');
assert.throws(() => servers.setAllowlist('memory-server', ['Bad Tool']), /allowedTools/);
servers.setAllowlist('memory-server', ['recall', 'remember']);

let snap = servers.recordHealth('memory-server', false);
assert.strictEqual(snap.health.status, 'unhealthy');
assert.strictEqual(snap.health.lastCheckedAt, 5000);
assert.strictEqual(snap.health.consecutiveFailures, 1);
denied(() => servers.checkTool('memory-server', 'recall'), 'unhealthy');
assert.deepStrictEqual(servers.visibleTools('memory-server', ['recall']), [], 'unhealthy server shows no tools');
snap = servers.recordHealth('memory-server', true);
assert.strictEqual(snap.health.status, 'healthy');
assert.strictEqual(snap.health.consecutiveFailures, 0);
assert.strictEqual(servers.checkTool('memory-server', 'recall'), true, 'recovered server usable again');

servers.disable('memory-server');
denied(() => servers.checkTool('memory-server', 'recall'), 'disabled');
servers.enable('memory-server');
assert.strictEqual(servers.checkTool('memory-server', 'recall'), true);
servers.revoke('memory-server');
denied(() => servers.checkTool('memory-server', 'recall'), 'untrusted');
assert.deepStrictEqual(servers.list().map((s) => s.id), ['memory-server']);

// ---------------------------------------------------------------- gateway integration (fail closed)
const memoryPlugin = {
  id: 'memory-mcp', name: 'Memory', version: '1.0.0', description: 'Memory over MCP', category: 'productivity',
  auth: { type: 'mcp', serverId: 'memory-server' }, permissions: ALL.slice(),
  installState: 'installed', connectionState: 'authorized',
  tools: [
    { id: 'recall', name: 'Recall', permission: 'profile:read' },
    { id: 'remember', name: 'Remember', permission: 'messages:write' },
  ],
};
const registry = Plugins.createRegistry([memoryPlugin]);

const noRegistry = ToolGateway.createGateway(registry);
assert.deepStrictEqual(noRegistry.discover({ grantedPermissions: ALL }), [], 'MCP tools hidden without a server registry');
assert.throws(() => noRegistry.authorize({ pluginId: 'memory-mcp', toolId: 'recall', grantedPermissions: ALL }),
  (e) => e.status === 403 && e.reason === 'mcp_unverified', 'MCP plugin denied without trust verification');

const gateway = ToolGateway.createGateway(registry, { mcpRegistry: servers });
assert.deepStrictEqual(gateway.discover({ grantedPermissions: ALL }), [], 'untrusted MCP server tools hidden in discovery');
assert.throws(() => gateway.authorize({ pluginId: 'memory-mcp', toolId: 'remember', grantedPermissions: ALL, approved: true, idempotencyKey: 'remember-key-1' }),
  (e) => e.status === 403 && e.reason === 'untrusted', 'untrusted server cannot bypass permissions even with approval');

servers.trust('memory-server');
assert.deepStrictEqual(gateway.discover({ grantedPermissions: ALL }).map((t) => t.id), ['recall', 'remember'], 'trusted + allowlisted tools visible');
assert.strictEqual(gateway.authorize({ pluginId: 'memory-mcp', toolId: 'recall', grantedPermissions: ALL }).access, 'read');
assert.strictEqual(gateway.authorize({ pluginId: 'memory-mcp', toolId: 'remember', grantedPermissions: ALL, approved: true, idempotencyKey: 'remember-key-1' }).access, 'write');

servers.setAllowlist('memory-server', ['recall']);
assert.deepStrictEqual(gateway.discover({ grantedPermissions: ALL }).map((t) => t.id), ['recall'], 'allowlist shrink hides tools in discovery');
assert.throws(() => gateway.authorize({ pluginId: 'memory-mcp', toolId: 'remember', grantedPermissions: ALL, approved: true, idempotencyKey: 'remember-key-2' }),
  (e) => e.status === 403 && e.reason === 'not_allowlisted', 'non-allowlisted tool denied at the gateway');

console.log('MCP ADAPTER TESTS PASSED');
