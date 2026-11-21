# Day 9 Security Review — plugin, OAuth and MCP paths

Date: 2026-11-21. Scope: everything added on Days 2–8 (`plugin-registry.js`, `tool-gateway.js`, `mcp-registry.js`, `marketplace.js`, `agent-memory.js`, `skills.js`, server `oauth.js`/`store.js`/`app.js` changes from Days 3–4). Method: code reading, targeted greps, and the new cross-component suite `tests/integration.test.js`. Verdict: **no known secret leakage and no approval bypass in the reviewed surface**; findings below are the checks performed and the boundaries that remain by design.

## Checks performed

| # | Threat | Where checked | Result |
|---|--------|---------------|--------|
| 1 | Token/secret values in logs | `grep console/process.stdout server/src/` | No logging calls in `server/src/`. Pass. |
| 2 | Token values in API responses | `GET /v1/oauth`, `GET /v1/secrets`, `GET /v1/audit` (integration test) | Responses contain names, scopes, who, timestamps only; seeded token/secret values absent. Pass. |
| 3 | Token values in audit trail | `store.auditPut` call sites + integration test | Events carry event/subject/detail = names and scopes only. Pass. |
| 4 | Plaintext secrets at rest | `tests/credential-security.test.js` (Day 4) | DB file bytes contain no seeded secret/token values; `master.key` is 0600; wrong key cannot unseal. Pass. |
| 5 | `client_secret` exposure | `server/src/oauth.js` token exchange/refresh | Sent in POST form body only; never in URLs, logs or error messages. Pass. |
| 6 | Provider error bodies leaking | `oauth.js` error paths | Errors surface the provider's error description (`said()`), never token responses. Pass. |
| 7 | Approval bypass via plugin tools | `tool-gateway.js authorize` | Write/admin tools require explicit approval + idempotency key; ungranted permissions, uninstalled and disconnected plugins denied 403. Pass. |
| 8 | Approval bypass via MCP | `mcp-registry.js checkTool` + gateway integration | Untrusted/disabled/unhealthy/non-allowlisted denied; MCP plugins denied entirely without a registry (`mcp_unverified`). Pass. |
| 9 | Approval bypass via skills | `skills.js validateSkill` | `autoApprove`, `skipApproval`, `bypassApproval`, `permissions`, `tools`, executable keys rejected; prompt block states skills never change approvals. Pass. |
| 10 | Executable plugin manifests | `plugin-registry.js` tool validation | `code/script/command/eval/exec/handler/run` keys and function values rejected at any depth; manifests are metadata only. Pass. |
| 11 | XSS through marketplace/memory UI | `marketplace.js render`, `app.js` sheets | All dynamic text via `textContent`; the only `innerHTML` use clears a container. HTML-injection-as-text covered by test. Pass. |
| 12 | Prototype pollution | `Object.assign` uses in Days 2–8 modules | Only internal literal patches (`{status}`, `{text}`, `{on}`); normalizers build objects from known keys. Pass. |
| 13 | Secrets entering agent memory | `agent-memory.js validateText` | Secret-looking assignments and private keys refused; pending agent suggestions excluded from the prompt until approved. Pass. |
| 14 | Cross-user credential access | Day 4 tests | Secrets and OAuth sessions are per-user; another user reads null. Pass. |
| 15 | Revocation delay | Day 4 tests + integration test | `oauthDel`/`disconnect` deny immediately (`requireUse` 403); re-grant works again. Pass. |

## Boundaries that remain by design

- **Gateway authorization is not execution.** The Day 5 gateway never runs tools; actual execution still goes through the Safety-gated `runTools` path in `core.js`, which applies its own approval rules per tool. Plugin tools are not yet wired into `runTools`; when they are, both gates must pass.
- **Tools without a declared permission are treated as read.** Plugin authors must declare a permission on every tool that writes or administers (see `docs/ADDING_A_PLUGIN.md`); the registry derives access from the permission suffix.
- **Pre-existing `new Function` runners** (`jsworker.js`, `project-preview.js`, `webtest.js`) execute the user's own project code inside the isolated preview/worker. They predate this sprint, are outside the Days 2–8 surface, and remain gated by the app's command approvals. Not changed here.
- **`load_skill` is the documented `wrapUntrusted` exception** (AGENTS.md rule 2): user-installed skill text enters the conversation as instructions. Skills are user-reviewed at install time and cannot carry approval fields (check 9).
- **MCP servers are never contacted by the registry.** Trust, allowlists and health are policy only; a future MCP client must run behind the same approval/untrusted-data path (`docs/handoff.md`).

## Failure-state QA

Covered by `tests/integration.test.js`: unconfigured OAuth provider returns a clear error and the API stays healthy; unhealthy MCP server denies, then recovers when healthy again; revoked OAuth session denies at once and a re-granted session works; empty registry/marketplace/memory/skills render clear empty states; Connect stays disabled while a setup requirement is unmet.
