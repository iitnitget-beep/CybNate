/* CybNate plugin marketplace (Day 7). A testable model + DOM renderer for the Plugins screen:
 * categories, search, plugin details with scopes/permissions shown before authorization,
 * install/uninstall and connect/disconnect states, and connected-accounts management.
 * The model reflects registry + backend state exactly; unavailable integrations carry a
 * setupRequirement instead of pretending to work. All DOM text goes through textContent. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./plugin-registry.js'));
  else root.Marketplace = factory(root.PluginRegistry);
})(typeof self !== 'undefined' ? self : this, function (Plugins) {
  'use strict';

  /* Built-in catalogue. Each entry is a declarative manifest plus the OAuth scopes that will be
   * requested, so the screen can show them before the user authorizes anything. */
  const CATALOGUE = Object.freeze([
    Object.freeze({
      manifest: Object.freeze({
        id: 'github', name: 'GitHub', version: '1.0.0', description: 'Repositories, issues and pull requests through your GitHub sign-in',
        category: 'development', publisher: 'CybNate', official: true,
        auth: Object.freeze({ type: 'oauth2', provider: 'github' }),
        permissions: Object.freeze(['profile:read', 'files:read', 'issues:write']),
        tools: Object.freeze([
          Object.freeze({ id: 'list-repos', name: 'List repositories', permission: 'files:read' }),
          Object.freeze({ id: 'create-issue', name: 'Create issue', permission: 'issues:write' }),
        ]),
      }),
      scopes: Object.freeze(['read:user', 'repo']),
    }),
    Object.freeze({
      manifest: Object.freeze({
        id: 'google-workspace', name: 'Google Workspace', version: '1.0.0', description: 'Drive files and Gmail through your Google sign-in',
        category: 'productivity', publisher: 'CybNate', official: true,
        auth: Object.freeze({ type: 'oauth2', provider: 'google' }),
        permissions: Object.freeze(['profile:read', 'files:read', 'messages:read']),
        tools: Object.freeze([
          Object.freeze({ id: 'drive-list', name: 'List Drive files', permission: 'files:read' }),
          Object.freeze({ id: 'gmail-read', name: 'Read Gmail', permission: 'messages:read' }),
        ]),
      }),
      scopes: Object.freeze(['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/gmail.readonly']),
    }),
    Object.freeze({
      manifest: Object.freeze({
        id: 'memory-mcp', name: 'Memory (MCP)', version: '1.0.0', description: 'Long-term memory served by a trusted MCP server',
        category: 'ai', publisher: 'CybNate', official: true,
        auth: Object.freeze({ type: 'mcp', serverId: 'memory-server' }),
        permissions: Object.freeze(['profile:read', 'messages:write']),
        tools: Object.freeze([
          Object.freeze({ id: 'recall', name: 'Recall', permission: 'profile:read' }),
          Object.freeze({ id: 'remember', name: 'Remember', permission: 'messages:write' }),
        ]),
      }),
      scopes: Object.freeze([]),
    }),
  ]);

  function setupRequirement(manifest, ctx) {
    if (ctx.appVersion && Plugins.checkCompatibility(manifest, ctx.appVersion).compatible === false) {
      return 'Needs app version ' + (manifest.minAppVersion || '') + ' or newer.';
    }
    const auth = manifest.auth || { type: 'none' };
    if (auth.type === 'oauth2') {
      const provider = ctx.providers.get(auth.provider);
      if (!ctx.serverConnected) return 'Connect a server in Settings to use sign-in plugins.';
      if (!provider) return 'This server does not offer ' + auth.provider + ' sign-in.';
      if (!provider.configured) return 'Sign-in is not set up on this server for ' + (provider.name || auth.provider) + '.';
      return null;
    }
    if (auth.type === 'mcp') {
      const server = ctx.mcpServers.get(auth.serverId);
      if (!server) return 'MCP server is not registered: ' + auth.serverId + '.';
      if (!server.enabled) return 'MCP server is disabled: ' + server.name + '.';
      if (server.trust !== 'trusted') return 'Trust this MCP server before use: ' + server.name + '.';
      if (server.health && server.health.status === 'unhealthy') return 'MCP server is unhealthy: ' + server.name + '.';
      return null;
    }
    if (auth.type === 'api_key' && manifest.connectionState !== 'configured' && manifest.connectionState !== 'connected') {
      return 'Add an API key in Secrets to configure this plugin.';
    }
    return null;
  }

  /** Build the screen model from catalogue entries + saved states + live backend state. */
  function buildModel(input) {
    const opts = input || {};
    const entries = Array.isArray(opts.entries) && opts.entries.length ? opts.entries : CATALOGUE;
    const states = opts.states || {};
    const providers = new Map((opts.providers || []).map((p) => [p.id, p]));
    const mcpServers = new Map((opts.mcpServers || []).map((s) => [s.id, s]));
    const ctx = { providers, mcpServers, serverConnected: !!opts.serverConnected, appVersion: opts.appVersion || null };
    const manifests = entries.map((en) => {
      try { return Plugins.applyState(en.manifest, states[en.manifest.id] || {}); }
      catch (e) { return Plugins.normalize(en.manifest); } // a stale saved state never breaks the screen
    });
    const registry = Plugins.createRegistry(manifests);
    const byId = new Map(entries.map((en) => [en.manifest.id, en]));
    const cards = registry.list().map((m) => {
      const en = byId.get(m.id) || {};
      const provider = m.auth.type === 'oauth2' ? providers.get(m.auth.provider) : null;
      const connected = (provider && provider.connected) || m.connectionState === 'connected';
      return Object.freeze({
        id: m.id, name: m.name, description: m.description, category: m.category,
        publisher: m.publisher, official: m.official, version: m.version, pinnedVersion: m.pinnedVersion,
        installState: m.installState,
        connectionState: connected ? 'connected' : m.connectionState,
        who: provider && provider.connected ? (provider.who || '') : '',
        authType: m.auth.type, provider: m.auth.provider || null, serverId: m.auth.serverId || null,
        permissions: m.permissions,
        scopes: Object.freeze(Array.isArray(en.scopes) ? en.scopes.slice() : []),
        grantedScopes: Object.freeze(provider && Array.isArray(provider.scopes) ? provider.scopes.slice() : []),
        tools: m.tools,
        setupRequirement: setupRequirement(m, ctx),
      });
    });
    const present = new Set(cards.map((c) => c.category));
    const categories = Object.freeze(Plugins.categories.filter((c) => present.has(c)));
    const accounts = Object.freeze([
      ...(opts.providers || []).filter((p) => p.connected).map((p) => Object.freeze({
        kind: 'oauth', id: p.id, name: p.name || p.id, who: p.who || '',
        scopes: Object.freeze(Array.isArray(p.scopes) ? p.scopes.slice() : []), canDisconnect: true,
      })),
      ...(opts.mcpServers || []).map((s) => Object.freeze({
        kind: 'mcp', id: s.id, name: s.name, trust: s.trust, enabled: !!s.enabled,
        health: s.health && s.health.status ? s.health.status : 'unknown',
        allowedTools: Object.freeze(Array.isArray(s.allowedTools) ? s.allowedTools.slice() : []), canDisconnect: false,
      })),
    ]);
    return Object.freeze({ cards: Object.freeze(cards), categories, accounts });
  }

  /** Search + category filter over built cards. */
  function filterCards(cards, filter) {
    const f = filter || {};
    const q = String(f.query || '').trim().toLowerCase();
    return (cards || []).filter((c) => {
      if (f.category && c.category !== f.category) return false;
      if (!q) return true;
      return (c.name + ' ' + c.description + ' ' + c.publisher + ' ' + c.category + ' ' + c.id).toLowerCase().indexOf(q) >= 0;
    });
  }

  /** Install/uninstall/connect/disconnect as pure state transitions on a manifest. */
  function transition(manifest, action) {
    const m = Plugins.normalize(manifest);
    if (action === 'install') return Plugins.applyState(m, { installState: 'installed' });
    if (action === 'uninstall') {
      const off = (m.connectionState === 'disconnected' || m.connectionState === 'error') ? m : Plugins.applyState(m, { connectionState: 'disconnected' });
      return Plugins.applyState(off, { installState: 'available' });
    }
    if (action === 'connect') return Plugins.applyState(m, { connectionState: 'connected' });
    if (action === 'disconnect') return Plugins.applyState(m, { connectionState: 'disconnected' });
    if (action === 'configure') return Plugins.applyState(m, { connectionState: 'configured' });
    throw new Error('Unknown marketplace action: ' + String(action || ''));
  }

  const STATE_LABEL = { available: 'Not installed', installed: 'Installed', disconnected: 'Not connected', configured: 'Configured', connected: 'Connected', authorized: 'Authorized', error: 'Error' };

  /** Render the model into a container. handlers.onAction(action, cardOrAccount). */
  function render(container, model, handlers, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !container) throw new Error('Marketplace render needs a DOM document and container');
    const onAction = handlers && typeof handlers.onAction === 'function' ? handlers.onAction : () => {};
    const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    container.innerHTML = '';

    if (model.accounts && model.accounts.length) {
      container.appendChild(el('div', 'inttitle', 'Connected accounts'));
      model.accounts.forEach((a) => {
        const row = el('div', 'mkaccount'); row.dataset.id = a.id; row.dataset.kind = a.kind;
        const label = a.kind === 'oauth'
          ? a.name + (a.who ? ' · ' + a.who : '') + (a.scopes.length ? ' · ' + a.scopes.length + ' scopes' : '')
          : a.name + ' · ' + a.trust + ' · ' + a.health + (a.enabled ? '' : ' · disabled') + ' · ' + a.allowedTools.length + ' tools allowed';
        row.appendChild(el('span', 'mkaccname', label));
        if (a.canDisconnect) {
          const b = el('button', 'mkbtn', 'Disconnect'); b.dataset.action = 'disconnect-account'; b.dataset.id = a.id;
          b.onclick = () => onAction('disconnect-account', a); row.appendChild(b);
        }
        container.appendChild(row);
      });
    }

    const cards = model.cards || [];
    if (!cards.length) { container.appendChild(el('p', 'intsub', 'No plugins match.')); return; }
    (model.categories || []).forEach((cat) => {
      const inCat = cards.filter((c) => c.category === cat);
      if (!inCat.length) return;
      container.appendChild(el('div', 'inttitle', cat));
      inCat.forEach((c) => {
        const card = el('div', 'mkcard'); card.dataset.id = c.id;
        const title = el('div', 'mkname', c.name + (c.official ? ' ✓' : '')); card.appendChild(title);
        card.appendChild(el('p', 'mkdesc', c.description));
        card.appendChild(el('p', 'mkmeta', 'v' + c.version + (c.publisher ? ' · ' + c.publisher : '') + ' · ' + (STATE_LABEL[c.installState] || c.installState) + ' · ' + (STATE_LABEL[c.connectionState] || c.connectionState) + (c.who ? ' · ' + c.who : '')));
        if (c.permissions.length) card.appendChild(el('p', 'mkperms', 'Permissions: ' + c.permissions.join(', ')));
        if (c.scopes.length) card.appendChild(el('p', 'mkscopes', 'Scopes: ' + c.scopes.join(', ')));
        if (c.tools.length) card.appendChild(el('p', 'mktools', 'Tools: ' + c.tools.map((t) => t.id + ' (' + t.access + (t.requiresApproval ? ', approval' : '') + ')').join(', ')));
        if (c.setupRequirement) card.appendChild(el('p', 'mknote', c.setupRequirement));
        const row = el('div', 'mkbtns');
        const btn = (action, label, disabled) => {
          const b = el('button', 'mkbtn', label); b.dataset.action = action; b.dataset.id = c.id;
          if (disabled) b.disabled = true; else b.onclick = () => onAction(action, c);
          row.appendChild(b);
        };
        if (c.installState === 'installed') {
          btn('uninstall', 'Uninstall');
          if (c.connectionState === 'connected' || c.connectionState === 'authorized') btn('disconnect', 'Disconnect');
          else btn('connect', 'Connect', !!c.setupRequirement);
        } else {
          btn('install', 'Install');
        }
        card.appendChild(row);
        container.appendChild(card);
      });
    });
  }

  return Object.freeze({ CATALOGUE, buildModel, filterCards, transition, render });
});
