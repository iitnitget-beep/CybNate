# CybNate — 10-day development sprint

## Operating rules
- Work only on `work/10-day-platform-sprint`; never push directly to `main`.
- No paid APIs, paid infrastructure, billing changes or production deployment without explicit owner approval.
- Every day ends with a commit, test evidence, changed-file list and unresolved blockers.
- Do not copy third-party code until its exact licence, dependency licences and security implications are checked.
- A plugin manifest is metadata, never executable code. Plugins run only through a permission-checked gateway.
- If a task cannot be safely completed, record the blocker rather than claiming success.

## Day 1 — Baseline and plugin registry foundation
- Recheck current main, open PRs, existing OAuth and backend storage.
- Define a declarative plugin manifest schema.
- Implement validation for identifiers, versions, categories, authentication types, permissions and tool metadata.
- Add unit tests and load the registry module in the app.
- Do not execute plugin-provided scripts.
**Acceptance:** valid manifests accepted; malformed IDs, versions, permissions, duplicate tools and duplicate plugin IDs rejected.

## Day 2 — Plugin catalogue and versioning
- Add official catalogue metadata and stable version pins.
- Add registry search/filter/category APIs.
- Define install state separately from connection state.
- Add compatibility and minimum app version fields.
**Acceptance:** deterministic catalogue listing; invalid/incompatible versions rejected.

## Day 3 — OAuth connection lifecycle
- Audit existing Google/GitHub PKCE flow.
- Define provider configuration, requested scopes and callback ownership.
- Add connect/status/disconnect lifecycle and explicit re-consent for added scopes.
- Do not embed OAuth client secrets in Android or web assets.
**Acceptance:** provider state isolated per user; state/PKCE validation and one-use callback tested.

## Day 4 — Credential security and permissions
- Verify encrypted token storage, key management and token refresh.
- Define least-privilege permission grants and revocation.
- Add audit events without logging tokens.
- Review CORS and session protections.
**Acceptance:** unauthorized tool requests denied; revoked connections cannot be used.

## Day 5 — AI Plugin Tool Gateway
- Map plugin tools to declarative schemas and permission requirements.
- Add tool discovery for connected plugins.
- Add user approval for write/deploy/admin actions.
- Add timeouts, rate limits and idempotency where appropriate.
**Acceptance:** read/write permission boundaries tested; no arbitrary code execution.

## Day 6 — MCP adapter
- Define MCP server registration and transport policy.
- Support explicit server trust and tool allowlists.
- Keep remote MCP credentials server-side.
- Add connection health and disable/revoke.
**Acceptance:** only approved tools visible; untrusted servers cannot bypass permissions.

## Day 7 — Plugin Marketplace UI
- Add marketplace screen, categories, search and plugin details.
- Add install/uninstall and connect/disconnect states.
- Show scopes and permissions before authorization.
- Add connected accounts management.
**Acceptance:** UI accurately reflects registry and backend state; unavailable integrations show setup requirements.

## Day 8 — Agent memory and skills
- Audit current session persistence and skill handling.
- Define project memory records and retention/deletion behavior.
- Add skill manifest validation and source/version provenance.
- Never run untrusted skill scripts directly.
**Acceptance:** memory is project/user scoped; skill metadata is validated and reviewable.

## Day 9 — Security and integration QA
- Test OAuth state, PKCE, CSRF, token encryption, permission revocation, malformed manifests and tool misuse.
- Run Node tests, backend tests, Android unit tests and emulator self-test.
- Fix regressions; document unavailable tests.
**Acceptance:** no known critical permission bypass; all executed tests have evidence.

## Day 10 — Release candidate preparation
- Run full audit and CI.
- Review privacy, permissions, error states and accessibility.
- Produce release notes, APK artifact and deployment checklist.
- Do not deploy production or activate paid resources without approval.
**Acceptance:** reproducible build, documented test results and explicit list of remaining production blockers.

## Current status
- Day 1 completed and verified on `work/10-day-platform-sprint` (2026-11-21: `npm ci` exit 0, `npm test` exit 0 — core, safety, router UI, project inventory and plugin registry suites passed).
- Day 2 implemented and verified (2026-11-21): catalogue metadata (`publisher`, `official`), stable version pins (`pinnedVersion`, prerelease pins rejected), compatibility (`minAppVersion`/`maxAppVersion` with rejection), deterministic listing, `byCategory`/`filter`/`compatibleWith`/`catalogue` APIs, and install state kept separate from connection state. `npm test` exit 0 after the change.
- Day 3 implemented and verified (2026-11-21): audited existing Google/GitHub PKCE flow in `server/src/oauth.js` (state + S256 PKCE, one-use callback, AES-256-GCM token storage in `server/src/store.js`). Added provider `allowedScopes` allowlists, `status(user, id)` + `GET /v1/oauth/:provider/status` (never returns tokens), explicit re-consent for added scopes (`start(..., {reconsent:true})`, otherwise 409 `needsReconsent`), and a PKCE-verifier-required guard in `callback()`. New `tests/oauth-lifecycle.test.js` (added to `npm test`) covers per-user isolation, state mismatch, missing verifier, callback replay, disconnect revocation, re-consent, unknown-scope rejection, and no client-secret literals in client assets. Evidence: `npm test` exit 0, `VERIFY_JS_ONLY=1 bash scripts/verify.sh` exit 0. Android/Gradle gate not run (java/gradle missing here). `server/test/server.test.js` fails pre-existing at its register step in this environment (verified identical on clean HEAD via `git stash`), unrelated to Day 3 changes.
- Day 4 implemented and verified (2026-11-21): verified AES-256-GCM token/secret storage (per-user AAD, no plaintext values in the DB file, wrong master key cannot unseal, file key forced to 0600), token refresh (expired tokens renewed and stored; a refused refresh deletes the session), least-privilege grants (`canUse`/`requireUse` in `server/src/oauth.js` — denied with 403 when not connected/revoked or a needed scope was not granted, denials audited), revocation (disconnect and device-token logout take effect immediately), audit events (`audit` table + `GET /v1/audit`, names/scopes/status only, never token values), and CORS/session review (Bearer-only auth with no cookies, optional pinned `corsOrigin`, `Referrer-Policy: no-referrer` + `X-Frame-Options: DENY` added). New `tests/credential-security.test.js` (added to `npm test`). Evidence: `npm test` exit 0, `VERIFY_JS_ONLY=1 bash scripts/verify.sh` exit 0. The register route's workspace chown still fails in this container (pre-existing, same as the `server/test/server.test.js` register step on Day 3), so the HTTP test creates its device token via the store.
- Day 5 implemented and verified (2026-11-21): declarative tool schemas in the plugin registry (`permission` must be declared in manifest permissions, `access` derived read/write/admin with `deploy:write` as admin, `timeoutMs` 100–120000, `inputSchema` object-only, executable keys and function values rejected — no arbitrary code execution), deterministic `listTools`/`toolsFor` APIs, and a new permission-checked gateway (`app/src/main/assets/www/tool-gateway.js`, loaded in `index.html`): discovery shows only installed + connected/authorized plugins' tools whose permission was granted; `authorize` denies unknown/uninstalled/disconnected plugins, unknown tools and ungranted permissions, requires explicit user approval plus an idempotency key for write/admin tools (repeated keys return the first invocation as duplicate), enforces per-tool rate limits, and returns an invocation descriptor with the tool timeout. The gateway never executes — invocations still run through the Safety-gated `runTools` path. New `tests/tool-gateway.test.js` (added to `npm test`). Evidence: `npm test` exit 0, `VERIFY_JS_ONLY=1 bash scripts/verify.sh` exit 0, `npm run test:ui` exit 0.
- Day 6 implemented and verified (2026-11-21): MCP server registry (`app/src/main/assets/www/mcp-registry.js`, loaded in `index.html`) with registration + transport policy (stdio = single program command without shell characters; http/sse = https only, http only for localhost, no credentials in URLs), remote credentials referenced by server-side secret name only (`credentialRef`; credential value fields rejected), explicit trust (servers start untrusted; `trust`/`revoke`), per-server tool allowlists, connection health (`recordHealth`, unhealthy servers hidden and denied), and disable/enable. The Day 5 gateway now fails closed for MCP plugins: without a server registry they are denied (`mcp_unverified`), and with one, discovery/authorize require trusted + enabled + healthy + allowlisted (`checkTool`), so untrusted servers cannot bypass permissions. No server is contacted or executed by the registry; calls still run through the Safety-gated `runTools` path. New `tests/mcp-adapter.test.js` (added to `npm test`). Evidence: `npm test` exit 0, `VERIFY_JS_ONLY=1 bash scripts/verify.sh` exit 0, `npm run test:ui` exit 0.
- Day 7 implemented and verified (2026-11-21): Plugin Marketplace UI. New `app/src/main/assets/www/marketplace.js` (loaded in `index.html`): built-in catalogue (GitHub, Google Workspace, Memory MCP) with per-plugin OAuth scopes, `buildModel` merging registry state with live backend provider state and MCP server state, categories + search (`filterCards`), scopes/permissions/tools shown on every card before authorization, `setupRequirement` for unavailable integrations (server not connected, provider not configured, MCP server unregistered/untrusted/disabled/unhealthy, API key missing, app too old), pure install/uninstall/connect/disconnect `transition`s, connected-accounts list, and a DOM `render` that uses `textContent` only. Wired into the app as a "Plugins" drawer entry opening a sheet (`openMarketplace` in `app.js`): install state persists in `settings.plugins`, sign-in state comes from `backend.signIns()`, connect starts the server OAuth flow, disconnect calls `backend.oauthOff`. New `tests/marketplace.test.js` (added to `npm test`, jsdom render + button + XSS-text checks). Evidence: `scripts/audit.sh` 13 passed, `npm test` exit 0, `VERIFY_JS_ONLY=1 bash scripts/verify.sh` exit 0, `npm run test:ui` exit 0.
- Day 8 implemented and verified (2026-11-21): Agent memory and skills. New `app/src/main/assets/www/agent-memory.js`: explicit memory model (preference/fact/outcome/tool-usage) over a plain entry array; user entries active at once, agent/system suggestions pending until approved; only active entries reach the prompt via a grouped, capped `promptBlock`; privacy controls (list/review, update, remove, clear, JSON export); secret-looking text and private keys refused; tool usage history capped at 50 and kept out of the prompt. New `app/src/main/assets/www/skills.js`: skills lifecycle over the app's skill entries — validation (kebab name, semver version, body limits), install/upgrade with downgrades refused, enable/disable, removal, discovery over a built-in catalogue (code-review, test-first), and approval/permission/executable fields rejected so skills cannot bypass approvals (the prompt block states this contract). Wiring: `extraPrompt` appends the memory block from `settings.agentMemory`; new Memory drawer sheet (`openMemory`) with approve/edit/delete/add/export/clear; `saveSkill` now installs through `Skills.install`; built-in catalogue rows added to Skills discover. New `tests/memory-skills.test.js` (added to `npm test`). Evidence: audit 13 passed, `npm test` exit 0, `VERIFY_JS_ONLY=1 bash scripts/verify.sh` exit 0, `npm run test:ui` exit 0.
- Day 9 implemented and verified (2026-11-21): Security and integration QA. Threat review of the plugin/OAuth/MCP paths written to `docs/SECURITY_REVIEW_DAY9.md` (15 checks: no token/secret values in logs, API responses or audit trail; `client_secret` in POST body only; gateway/MCP/skills approval gates hold; manifests cannot carry executable content; UI renders via textContent; no prototype-pollution surface in the new modules; secrets refused in memory; per-user credential isolation; immediate revocation) — no known secret leakage or approval bypass in the reviewed surface, with by-design boundaries documented (gateway never executes, undeclared-permission tools are read-only, pre-existing sandboxed `new Function` runners, `load_skill` exception). New cross-component suite `tests/integration.test.js` (added to `npm test`): catalogue → marketplace → gateway → MCP trust/health recovery → memory approval flow → skills lifecycle on the client, and OAuth list/audit leak checks, unconfigured-provider error recovery, immediate revocation + re-grant on the server, plus empty/error states. New `docs/ADDING_A_PLUGIN.md` (manifest rules, auth choices, runtime gates, test checklist). Evidence: audit 13 passed, `npm test` exit 0, `VERIFY_JS_ONLY=1 bash scripts/verify.sh` exit 0, `npm run test:ui` exit 0.
- Existing backend OAuth PKCE and encrypted token storage identified; provider support currently includes Google and GitHub.
- Existing app has an Integrations entry point; plugin marketplace is not yet implemented.
- No production deployment or paid service activated.
