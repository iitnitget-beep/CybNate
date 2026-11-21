'use strict';
/* Day 9 — Cross-component integration QA: catalogue -> marketplace -> gateway -> MCP ->
   memory -> skills on the client, and registry state -> OAuth -> audit on the server.
   Also covers error/empty states and recoverable failures (unhealthy MCP recovers,
   revoked OAuth can be re-granted, unconfigured provider errors without breaking the API). */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Plugins = require('../app/src/main/assets/www/plugin-registry.js');
const ToolGateway = require('../app/src/main/assets/www/tool-gateway.js');
const Mcp = require('../app/src/main/assets/www/mcp-registry.js');
const Marketplace = require('../app/src/main/assets/www/marketplace.js');
const AgentMemory = require('../app/src/main/assets/www/agent-memory.js');
const Skills = require('../app/src/main/assets/www/skills.js');
const Store = require('../server/src/store');
const OAuth = require('../server/src/oauth');
const App = require('../server/src/app');

const denied = (fn, reason) => assert.throws(fn, (e) => e.status === 403 && e.reason === reason, 'denied: ' + reason);

// ---------------------------------------------------------------- client: catalogue -> marketplace -> gateway
const states = {
  github: { installState: 'installed', connectionState: 'connected' },
  'memory-mcp': { installState: 'installed', connectionState: 'authorized' },
};
const providers = [{ id: 'github', name: 'GitHub', configured: true, connected: true, who: 'octocat', scopes: ['read:user', 'repo'] }];
const model = Marketplace.buildModel({ states, providers, mcpServers: [], serverConnected: true });
const ghCard = model.cards.find((c) => c.id === 'github');
assert.strictEqual(ghCard.connectionState, 'connected');
assert.ok(ghCard.scopes.length >= 2 && ghCard.permissions.length >= 2, 'scopes + permissions visible before authorization');

const manifests = Marketplace.CATALOGUE.map((en) => Plugins.applyState(en.manifest, states[en.manifest.id] || {}));
const registry = Plugins.createRegistry(manifests);
const gateway = ToolGateway.createGateway(registry);
const readOnly = gateway.discover({ grantedPermissions: ['files:read'] }).map((t) => t.id);
assert.ok(readOnly.includes('list-repos'), 'granted read tool discoverable');
assert.ok(!readOnly.includes('create-issue'), 'ungranted write tool hidden');
assert.strictEqual(gateway.authorize({ pluginId: 'github', toolId: 'list-repos', grantedPermissions: ['files:read'] }).access, 'read');
denied(() => gateway.authorize({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ['issues:write'] }), 'approval_required');
const inv = gateway.authorize({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ['issues:write'], approved: true, idempotencyKey: 'issue-key-1' });
assert.strictEqual(inv.access, 'write');
assert.strictEqual(gateway.authorize({ pluginId: 'github', toolId: 'create-issue', grantedPermissions: ['issues:write'], approved: true, idempotencyKey: 'issue-key-1' }).duplicate, true, 'idempotent repeat returns the first invocation');

// ---------------------------------------------------------------- client: MCP trust is recoverable
denied(() => gateway.authorize({ pluginId: 'memory-mcp', toolId: 'recall', grantedPermissions: ['profile:read'] }), 'mcp_unverified');
const servers = Mcp.createMcpRegistry([{ id: 'memory-server', name: 'Memory Server', transport: 'http', url: 'https://mcp.example.test/mcp', credentialRef: 'MEMORY_MCP_TOKEN', allowedTools: ['recall', 'remember'] }]);
const mcpGateway = ToolGateway.createGateway(registry, { mcpRegistry: servers });
denied(() => mcpGateway.authorize({ pluginId: 'memory-mcp', toolId: 'recall', grantedPermissions: ['profile:read'] }), 'untrusted');
servers.trust('memory-server');
assert.strictEqual(mcpGateway.authorize({ pluginId: 'memory-mcp', toolId: 'recall', grantedPermissions: ['profile:read'] }).access, 'read');
servers.recordHealth('memory-server', false);
denied(() => mcpGateway.authorize({ pluginId: 'memory-mcp', toolId: 'recall', grantedPermissions: ['profile:read'] }), 'unhealthy');
servers.recordHealth('memory-server', true);
assert.strictEqual(mcpGateway.authorize({ pluginId: 'memory-mcp', toolId: 'recall', grantedPermissions: ['profile:read'] }).access, 'read', 'recovered MCP server works again (failure is recoverable)');

// ---------------------------------------------------------------- client: memory + skills in the prompt path
const mem = AgentMemory.createStore([]);
const suggestion = mem.add({ kind: 'fact', text: 'Deploys go to Vercel', source: 'agent' });
assert.ok(!mem.promptBlock().includes('Vercel'), 'unapproved suggestion stays out of the prompt');
mem.approve(suggestion.id);
assert.ok(mem.promptBlock().includes('Deploys go to Vercel'));
assert.throws(() => mem.add({ kind: 'fact', text: 'token: abcdefgh12345678' }), /secrets/, 'secret refused even mid-flow');

let skillList = Skills.install([], Skills.CATALOGUE[0]).list;
assert.ok(Skills.promptBlock(skillList).includes('never change approvals'));
assert.throws(() => Skills.install(skillList, { ...Skills.CATALOGUE[0], autoApprove: true }), /cannot carry/, 'approval-bypass skill refused');

// ---------------------------------------------------------------- client: empty + error states
const emptyGateway = ToolGateway.createGateway(Plugins.createRegistry([]));
assert.deepStrictEqual(emptyGateway.discover({ grantedPermissions: [] }), []);
denied(() => emptyGateway.authorize({ pluginId: 'nope', toolId: 'x', grantedPermissions: [] }), 'unknown_plugin');
assert.strictEqual(AgentMemory.promptBlock([]), '');
assert.deepStrictEqual(Skills.discover('zzz-no-match'), []);
const dom = new JSDOM('<!doctype html><body><div id="box"></div></body>');
Marketplace.render(dom.window.document.getElementById('box'), { cards: [], categories: [], accounts: [] }, { onAction: () => {} }, dom.window.document);
assert.ok(dom.window.document.getElementById('box').textContent.includes('No plugins match.'), 'empty marketplace renders a clear empty state');
// connect is disabled while a setup requirement is unmet
const blockedModel = Marketplace.buildModel({ states: { github: { installState: 'installed', connectionState: 'disconnected' } }, providers: [], mcpServers: [], serverConnected: false });
Marketplace.render(dom.window.document.getElementById('box'), blockedModel, { onAction: () => {} }, dom.window.document);
const connectBtn = dom.window.document.querySelector('.mkcard[data-id="github"] button[data-action="connect"]');
assert.ok(connectBtn && connectBtn.disabled, 'connect disabled until setup requirement is met');

// ---------------------------------------------------------------- server: OAuth list/audit never leak, failures recoverable
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyb-int-'));
  const app = App.create({ dataDir: dir, accessKey: 'test-access-key-123456', allowShared: true, allowPrivate: true, publicUrl: 'http://127.0.0.1', lspServers: {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json };
  };
  try {
    const reg = app.store.register('Asha', 'phone-a');
    assert.strictEqual((await call('GET', '/v1/health')).status, 200);
    // unconfigured provider (no Google client in env): clear error, API stays alive afterwards
    const start = await call('POST', '/v1/oauth/google/start', { scopes: ['openid'] }, reg.token);
    assert.ok(start.status >= 400 && start.json && start.json.error, 'unconfigured provider errors clearly');
    assert.strictEqual((await call('GET', '/v1/health')).status, 200, 'API still healthy after the error (recoverable)');

    // provider list carries no token material
    app.store.oauthPut(reg.id, 'google', { access: 'tok-leak-check', refresh: 'ref-leak-check', exp: Date.now() + 3600e3, scopes: ['openid'], who: 'asha@example.com', at: Date.now() });
    const list = await call('GET', '/v1/oauth', undefined, reg.token);
    assert.strictEqual(list.status, 200);
    assert.ok(!list.text.includes('tok-leak-check') && !list.text.includes('ref-leak-check'), 'OAuth list never contains token values');

    // audit trail records names, never values
    await call('PUT', '/v1/secrets/INT_KEY', { value: 'int-secret-value-999' }, reg.token);
    const audit = await call('GET', '/v1/audit?limit=50', undefined, reg.token);
    assert.strictEqual(audit.status, 200);
    assert.ok(audit.text.includes('secret.put') && audit.text.includes('INT_KEY'), 'audit records the event and name');
    assert.ok(!audit.text.includes('int-secret-value-999') && !audit.text.includes('tok-leak-check'), 'audit never contains secret or token values');

    // revocation is immediate, and re-granting works again
    assert.strictEqual(app.oauth.canUse({ id: reg.id }, 'google', ['openid']).ok, true);
    app.store.oauthDel(reg.id, 'google');
    assert.throws(() => app.oauth.requireUse({ id: reg.id }, 'google', ['openid']), (e) => e.status === 403, 'revoked session denied at once');
    app.store.oauthPut(reg.id, 'google', { access: 'tok-again', refresh: '', exp: Date.now() + 3600e3, scopes: ['openid'], who: '', at: Date.now() });
    assert.strictEqual(app.oauth.canUse({ id: reg.id }, 'google', ['openid']).ok, true, 're-granted session works again (recoverable)');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('INTEGRATION TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
