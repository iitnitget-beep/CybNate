# Adding a plugin safely

A plugin in CybNate is a **declarative manifest** plus tools the agent may request. Manifests are metadata only — they never contain code, and every tool call still passes the gateway checks and the Safety approval gate before anything runs. This guide is the checklist for adding one without weakening that.

## 1. Write the manifest

Manifests are validated by `plugin-registry.js`. Required shape:

```js
{
  id: 'my-plugin',              // lowercase kebab-case, 1-64 chars, unique
  name: 'My Plugin',            // 1-80 chars
  version: '1.0.0',             // semver; pin it (pinnedVersion defaults to version)
  description: 'What it does',  // shown in the marketplace
  category: 'development',      // development | cloud | productivity | research | ai | other
  publisher: 'Your Name',
  official: false,
  auth: { type: 'oauth2', provider: 'github' },   // none | api_key | oauth2 | mcp
  permissions: ['files:read', 'issues:write'],    // from the fixed permission set
  minAppVersion: '1.0.0',       // optional compatibility floor
  tools: [
    { id: 'list-things', name: 'List things', permission: 'files:read' },
    { id: 'create-thing', name: 'Create thing', permission: 'issues:write', timeoutMs: 15000 },
  ],
}
```

Rules the validator enforces (violations are rejected, not repaired):

- Every tool's `permission` **must be declared** in the manifest's `permissions`. Declare a permission on every tool: access is derived from its suffix (`:read` → read, `:write` → write, `deploy:write` → admin), and write/admin tools require the user's explicit approval plus an idempotency key at call time. A tool with no permission is treated as read-only — never rely on that for a tool that changes anything.
- No executable content anywhere in the manifest: `code`, `script`, `command`, `eval`, `exec`, `handler`, `run` keys and function values are rejected at any depth.
- `inputSchema` must be a plain object schema; `timeoutMs` must be 100–120000 (default 30000).
- Tool ids are unique per plugin; plugin ids are unique across the catalogue.

## 2. Choose the auth type

- `none` — no credentials (local-only plugins).
- `api_key` — the user adds a key in Secrets; the plugin is `configured` once the key exists. Never put a key in the manifest.
- `oauth2` — `{ type: 'oauth2', provider: '<server provider id>' }`. The server must offer that provider (see `server/src/oauth.js`); tokens stay server-side, encrypted. List the scopes your plugin needs in the marketplace entry so the user sees them **before** authorizing. Request the narrowest scopes that work; the server enforces a per-provider scope allowlist and requires re-consent when scopes grow.
- `mcp` — `{ type: 'mcp', serverId: '<registered server id>' }`. The server must be registered in `mcp-registry.js`, explicitly trusted by the user, enabled and healthy, and each tool must be on the server's allowlist. Credentials are referenced by server-side secret **name** (`credentialRef`) only — never by value, and never in a URL.

## 3. Add it to the catalogue

Add an entry to `CATALOGUE` in `app/src/main/assets/www/marketplace.js`:

```js
Object.freeze({
  manifest: Object.freeze({ /* manifest above */ }),
  scopes: Object.freeze(['read:user', 'repo']),  // OAuth scopes shown before authorization; [] for non-OAuth
}),
```

The marketplace model merges your manifest with saved install state and live backend state. If your plugin cannot work yet (provider not configured, MCP server untrusted, API key missing), the screen shows a setup requirement automatically — do not fake a connected state.

## 4. Respect the runtime gates

- Discovery shows your tools only when the plugin is **installed + connected** and the user granted each tool's permission.
- `ToolGateway.authorize` denies unknown/uninstalled/disconnected plugins, unknown tools and ungranted permissions (403), requires approval + idempotency for write/admin, and rate-limits per tool. MCP plugins additionally require a trusted, allowlisted server.
- The gateway never executes. Execution goes through the Safety-gated `runTools` path, and results are wrapped as untrusted data before reaching the model. Do not add a second executor.

## 5. Test before shipping

- `Plugins.validate(manifest).valid` is `true` (the marketplace test asserts this for every catalogue entry).
- Add coverage in `tests/` for: discovery visibility, a denied call (ungranted/unapproved), an approved write with idempotency, and any setup-requirement state your plugin can hit.
- Run the full gate: `bash scripts/audit.sh`, `npm test`, `VERIFY_JS_ONLY=1 bash scripts/verify.sh`, `npm run test:ui`.

## Never do this

- Never embed tokens, keys or passwords in a manifest, skill, memory entry or URL.
- Never ask the user to paste a secret into chat; secrets go through the Secrets screen or server sign-in.
- Never widen the permission set, the read-only command list, or approval rules to make a plugin work — narrow the plugin instead.
- Never log credential values; audit events record names and scopes only.
