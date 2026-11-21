# CybNate Implementation Tracker

This tracker is a working plan, not a statement that the items are implemented. Keep each item tied to a PR/commit and test evidence.

## P0 — Baseline and safety
- [ ] Produce a fresh complete test/build baseline.
- [x] Add explicit incomplete-report handling, a strict report validator, regression fixtures, and CI diagnostic upload. (Day 6 implementation; workflow execution still pending.)
- [ ] Audit Git history for exposed signing material; rotate compromised signing credentials and define a safe release-key process.
- [ ] Move local provider credentials out of WebView localStorage.
- [ ] Enforce real per-user execution isolation before public multi-user use.
- [ ] Review cleartext policy, URL allowlists, redirects, SSRF protections and preview origin separation.

## Plugin platform (10-day sprint)
- [x] Day 1: declarative plugin manifest registry with validation and unit tests (verified 2026-11-21, `npm test` exit 0).
- [x] Day 2: plugin catalogue metadata, stable version pins, compatibility/min-app-version checks, deterministic search/filter/category APIs, install state separate from connection state (verified 2026-11-21, `npm test` exit 0).
- [x] Day 3: OAuth connection lifecycle — provider scope allowlists (Google/GitHub defaults), connect/status/disconnect (`status()` + `GET /v1/oauth/:provider/status`), explicit re-consent (409 `needsReconsent`) for added scopes on existing connections, PKCE-verifier-required callback guard (verified 2026-11-21, `npm test` exit 0 incl. new `tests/oauth-lifecycle.test.js`; `VERIFY_JS_ONLY=1` exit 0; Android/Gradle gate NOT run — java/gradle missing in this environment; `server/test/server.test.js` fails pre-existing at register step in this environment, verified identical on clean HEAD via stash, unrelated to Day 3).
- [x] Day 4: credential security and permissions — encrypted-storage/key/refresh verification, least-privilege `canUse`/`requireUse` grants (403 when not connected/revoked or scope ungranted), immediate revocation (disconnect, refused refresh, logout), audit events without token values (`audit` table + `GET /v1/audit`), CORS/session hardening (optional pinned origin, Referrer-Policy/X-Frame-Options) (verified 2026-11-21, `npm test` exit 0 incl. new `tests/credential-security.test.js`; `VERIFY_JS_ONLY=1` exit 0; register-route workspace chown fails pre-existing in this container, HTTP test uses a store-created device token).

## P1 — Coding engine foundations
- [ ] Define typed agent manifest schema (ID, version, role, model policy, tools, permissions, output schema).
- [ ] Add agent-manifest validation and version pinning.
- [ ] Add Tree-sitter parser adapter and language capability registry.
- [ ] Build incremental symbol index and project map.
- [ ] Add proposed-change store, unified diff review, approval and apply transaction.
- [ ] Persist run events, task state, cancellation and resume checkpoints.
- [ ] Add structured evidence to task completion (changed files, commands, tests, logs, known limitations).

## P2 — Harness and model adapters
- [ ] Define common harness interface for Codex, Claude Code, Gemini and OpenHands.
- [ ] Separate model provider credentials from harness execution credentials.
- [ ] Normalize progress, tool requests, approval events, diffs and final results.
- [ ] Add per-provider rate limits, budgets, retries and safe fallback.
- [ ] Never assume a consumer subscription grants API/SDK access.

## P3 — Cloud workspace and preview
- [ ] Design per-user/per-project isolated workspace lifecycle.
- [ ] Define CPU, memory, disk, process, time and egress quotas.
- [ ] Separate preview origin from app origin and deny access to privileged cookies/bridges.
- [ ] Add artifact storage with retention and deletion policy.
- [ ] Evaluate free/local execution first; require approval before any paid hosted resource.

## P4 — Product and launch readiness
- [ ] Improve editor UX, file tree, search, diff and terminal on mobile.
- [ ] Add web client with responsive workspace.
- [ ] Add project export/import and reliable GitHub sync.
- [ ] Add auth, project ownership, usage metering and abuse protection.
- [ ] Design credits/subscriptions only after actual per-task costs are measured.
- [ ] Complete privacy, terms, security review, accessibility and Play Store release checklist.

## Working rules
- Keep `main` protected from direct development changes.
- Make focused commits on a feature branch and use pull requests for review.
- No paid infrastructure or API activation without explicit user approval.
- Never copy code until its exact file-level license and dependency obligations are checked.
- No feature is complete until relevant tests run and evidence is recorded.
- Mark unavailable tests honestly; do not convert a skipped test into a pass.
