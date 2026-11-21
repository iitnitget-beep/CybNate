'use strict';
/* Day 7 — Plugin Marketplace UI: model reflects registry + backend state, categories/search,
   scopes and permissions shown before authorization, install/uninstall and connect/disconnect
   transitions, connected-accounts management, setup requirements for unavailable integrations,
   and DOM rendering (textContent only) with working buttons. */
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const Plugins = require('../app/src/main/assets/www/plugin-registry.js');
const Marketplace = require('../app/src/main/assets/www/marketplace.js');

// ---------------------------------------------------------------- catalogue is valid
Marketplace.CATALOGUE.forEach((en) => {
  assert.strictEqual(Plugins.validate(en.manifest).valid, true, 'catalogue manifest validates: ' + en.manifest.id);
});

// ---------------------------------------------------------------- model: states, backend merge, setup requirements
const providers = [
  { id: 'github', name: 'GitHub', configured: true, connected: true, who: 'octocat', scopes: ['read:user', 'repo'] },
  { id: 'google', name: 'Google', configured: false, connected: false, who: '', scopes: [] },
];
const mcpServers = [
  { id: 'memory-server', name: 'Memory Server', trust: 'untrusted', enabled: true, health: { status: 'unknown' }, allowedTools: ['recall'] },
];
const model = Marketplace.buildModel({
  states: { github: { installState: 'installed', connectionState: 'disconnected' } },
  providers, mcpServers, serverConnected: true,
});
assert.deepStrictEqual(model.cards.map((c) => c.id).sort(), ['github', 'google-workspace', 'memory-mcp'], 'all catalogue cards present');
const byId = Object.fromEntries(model.cards.map((c) => [c.id, c]));
const gh = byId.github, gw = byId['google-workspace'], mm = byId['memory-mcp'];
assert.strictEqual(gh.installState, 'installed');
assert.strictEqual(gh.connectionState, 'connected', 'backend connected state wins over saved state');
assert.strictEqual(gh.who, 'octocat');
assert.deepStrictEqual(gh.grantedScopes, ['read:user', 'repo']);
assert.strictEqual(gh.setupRequirement, null);
assert.ok(gh.scopes.includes('repo'), 'scopes to request are known before authorization');
assert.ok(gh.permissions.includes('issues:write'), 'permissions shown before authorization');
assert.strictEqual(gw.setupRequirement, 'Sign-in is not set up on this server for Google.', 'unavailable integration shows its setup requirement');
assert.strictEqual(mm.setupRequirement, 'Trust this MCP server before use: Memory Server.', 'untrusted MCP server shows its setup requirement');
assert.deepStrictEqual(model.categories, ['development', 'productivity', 'ai']);

const noServer = Marketplace.buildModel({ providers: [], mcpServers: [], serverConnected: false });
const noById = Object.fromEntries(noServer.cards.map((c) => [c.id, c]));
assert.strictEqual(noById.github.setupRequirement, 'Connect a server in Settings to use sign-in plugins.');
assert.strictEqual(noById['memory-mcp'].setupRequirement, 'MCP server is not registered: memory-server.');
assert.deepStrictEqual(noServer.accounts, []);

// connected accounts management
assert.deepStrictEqual(model.accounts.map((a) => a.kind + ':' + a.id), ['oauth:github', 'mcp:memory-server']);
assert.strictEqual(model.accounts[0].canDisconnect, true);
assert.strictEqual(model.accounts[0].who, 'octocat');
assert.strictEqual(model.accounts[1].trust, 'untrusted');
assert.deepStrictEqual(model.accounts[1].allowedTools, ['recall']);

// stale saved state never breaks the screen
const stale = Marketplace.buildModel({ states: { github: { installState: 'available', connectionState: 'connected' } }, providers, mcpServers, serverConnected: true });
assert.strictEqual(stale.cards.find((c) => c.id === 'github').installState, 'available', 'invalid saved state falls back to the manifest');

// ---------------------------------------------------------------- search + category filter
assert.deepStrictEqual(Marketplace.filterCards(model.cards, { query: 'git' }).map((c) => c.id), ['github']);
assert.deepStrictEqual(Marketplace.filterCards(model.cards, { query: 'memory' }).map((c) => c.id), ['memory-mcp']);
assert.deepStrictEqual(Marketplace.filterCards(model.cards, { category: 'productivity' }).map((c) => c.id), ['google-workspace']);
assert.deepStrictEqual(Marketplace.filterCards(model.cards, {}).length, 3);

// ---------------------------------------------------------------- transitions
const raw = Marketplace.CATALOGUE[0].manifest;
assert.throws(() => Marketplace.transition(raw, 'connect'), /installed/, 'connect before install is refused');
const installed = Marketplace.transition(raw, 'install');
assert.strictEqual(installed.installState, 'installed');
const connected = Marketplace.transition(installed, 'connect');
assert.strictEqual(connected.connectionState, 'connected');
const uninstalled = Marketplace.transition(connected, 'uninstall');
assert.strictEqual(uninstalled.installState, 'available');
assert.strictEqual(uninstalled.connectionState, 'disconnected', 'uninstall disconnects first');
assert.throws(() => Marketplace.transition(raw, 'explode'), /Unknown marketplace action/);

// ---------------------------------------------------------------- DOM render + buttons
const dom = new JSDOM('<!doctype html><body><div id="box"></div></body>');
const doc = dom.window.document;
const box = doc.getElementById('box');
const actions = [];
Marketplace.render(box, model, { onAction: (action, item) => actions.push(action + ':' + item.id) }, doc);
assert.strictEqual(box.querySelectorAll('.mkcard').length, 3, 'one card per plugin');
assert.ok(box.textContent.includes('Permissions: profile:read, files:read, issues:write'), 'permissions rendered');
assert.ok(box.textContent.includes('Scopes: read:user, repo'), 'scopes rendered before authorization');
assert.ok(box.textContent.includes('Sign-in is not set up on this server for Google.'), 'setup requirement rendered');
assert.ok(box.textContent.includes('Connected accounts'), 'accounts section rendered');
assert.ok(box.textContent.includes('octocat'), 'account identity rendered');
const ghCard = box.querySelector('.mkcard[data-id="github"]');
assert.ok(ghCard.textContent.includes('Installed') && ghCard.textContent.includes('Connected'), 'states rendered on the card');
const uninstallBtn = ghCard.querySelector('button[data-action="uninstall"]');
assert.ok(uninstallBtn, 'installed plugin offers uninstall');
uninstallBtn.click();
assert.deepStrictEqual(actions, ['uninstall:github'], 'button reports its action');
const gwCard = box.querySelector('.mkcard[data-id="google-workspace"]');
const installBtn = gwCard.querySelector('button[data-action="install"]');
assert.ok(installBtn, 'available plugin offers install');
installBtn.click();
assert.deepStrictEqual(actions, ['uninstall:github', 'install:google-workspace']);
const discBtn = box.querySelector('button[data-action="disconnect-account"]');
assert.ok(discBtn, 'connected account offers disconnect');
discBtn.click();
assert.strictEqual(actions[2], 'disconnect-account:github');

// text is never interpreted as HTML
const evil = Marketplace.buildModel({
  entries: [{ manifest: { id: 'evil', name: '<img src=x onerror=alert(1)>', version: '1.0.0', description: '<b>bold</b>', category: 'other', auth: { type: 'none' }, permissions: [], tools: [] }, scopes: [] }],
  providers: [], mcpServers: [], serverConnected: false,
});
Marketplace.render(box, evil, { onAction: () => {} }, doc);
assert.strictEqual(box.querySelectorAll('img').length, 0, 'plugin names are text, not HTML');
assert.ok(box.textContent.includes('<img src=x onerror=alert(1)>'), 'name shown as literal text');

console.log('MARKETPLACE TESTS PASSED');
