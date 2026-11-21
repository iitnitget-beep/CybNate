# Changelog

## 1.1.0 — 10-day platform sprint (2026-11-21, branch `work/10-day-platform-sprint`)

Release candidate from the 10-day sprint. App `package.json` 1.0.0 → 1.1.0, server 0.1.0 → 0.2.0. The Android `versionName` remains CI-driven (`1.0.<run number>`).

### Added

- **Plugin catalogue (Day 2):** declarative plugin registry with manifest validation, version pins, compatibility checks, deterministic listing/search/filter, and install state kept separate from connection state.
- **OAuth lifecycle (Day 3, server):** per-provider scope allowlists, connection status API, re-consent (409) when scopes grow, PKCE guard, per-user isolation.
- **Credential security (Day 4, server):** audit trail with names/scopes only (never token values), least-privilege `canUse`/`requireUse` grants, immediate revocation, encrypted storage hardening (`master.key` 0600), CORS/session headers.
- **AI plugin tool gateway (Day 5):** declarative tool schemas (declared permissions, derived read/write/admin access, bounded timeouts, executable fields rejected), discovery for installed+connected plugins, approval + idempotency keys for write/admin, per-tool rate limits. The gateway authorizes; it never executes.
- **MCP adapter policy (Day 6):** MCP server registration with transport policy (stdio single-command, remote https-only), explicit trust/revoke, per-server tool allowlists, health tracking, credentials by server-side secret name only, fail-closed gateway checks.
- **Plugin Marketplace UI (Day 7):** Plugins drawer sheet with categories/search, scopes/permissions/tools shown before authorization, install/connect states, connected-accounts management, and setup requirements for unavailable integrations.
- **Agent memory and skills (Day 8):** explicit memory (preferences, facts, outcomes, tool usage) with pending-approval agent suggestions, secret refusal, review/edit/delete/export, and prompt integration; versioned skills lifecycle (discovery, install/upgrade, enable/disable, removal) with approval-bypass fields rejected.
- **Security and integration QA (Day 9):** threat review (`docs/SECURITY_REVIEW_DAY9.md`), cross-component integration tests including recoverable failures and empty states, and `docs/ADDING_A_PLUGIN.md`.

### Verification

- `bash scripts/audit.sh` — 13 passed, 0 failed.
- `npm test` — 12 suites green (core, safety, router UI, project index, plugin registry, OAuth lifecycle, credential security, tool gateway, MCP adapter, marketplace, memory+skills, integration).
- `VERIFY_JS_ONLY=1 bash scripts/verify.sh` — JS-only gate green. This is **not** the full Android gate.
- `npm run test:ui` — UI smoke green. `npm run test:preview` — preview isolation green.
- The Android APK is built by CI on every push to the branch (`release/CybNate.apk`, `build: CybNate APK #<n>` commits). The full Gradle gate (JDK 17, Gradle, Android SDK 34) was not run in the development container, which lacks that toolchain.

### Known limitations (not hidden)

- This release candidate lives on branch `work/10-day-platform-sprint` only. Nothing was merged to `main`; the merge decision is the owner's.
- Plugin tools are authorized by the gateway but not yet wired into the `runTools` execution path; MCP has a policy/registry layer but no live MCP client yet. Both must stay behind the existing approval/untrusted-data path.
- `server/test/server.test.js` register step fails in containers without per-user uid mapping (workspace `chown` EINVAL) — pre-existing environment issue, verified identical on a clean tree; the same routes are covered over real HTTP in `tests/credential-security.test.js` and `tests/integration.test.js` using store-created device tokens.
- The old signing key remains in Git history and must be treated as compromised (see `docs/handoff.md`); history was not rewritten.
- Lint remains non-blocking until run with the full Android toolchain (see `docs/handoff.md`).
