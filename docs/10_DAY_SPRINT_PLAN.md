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
- Existing backend OAuth PKCE and encrypted token storage identified; provider support currently includes Google and GitHub.
- Existing app has an Integrations entry point; plugin marketplace is not yet implemented.
- No production deployment or paid service activated.
