# CybNate handoff — current audit and open work

## Repository and signing status

- The original `keystore/cybnate.jks` was tracked and appeared in reachable Git history. Its password was also embedded in the old Gradle configuration/workflow. Treat the key as compromised; it has been removed from the current tree in this work, and signing now uses GitHub Actions secrets with debug-sign fallback.
- This change does **not** purge history. That is optional later cleanup and requires an explicit decision plus a history rewrite/force-push. Any existing forks or clones retain their copy of the old key regardless of a purge from this repository.
- Until the new signing secrets are present, the CI APK is debug-signed and cannot update an installed app signed by another key. See `README.md` for key setup instructions.
- The APK remains committed at `release/CybNate.apk`; CI continues publishing `release/selftest.txt` and device-test artifacts.

## Verification and build

- `package.json` and `package-lock.json` provide the jsdom test dependency and test scripts; CI uses `npm ci` rather than installing jsdom into a temporary directory.
- `scripts/verify.sh` runs the core and safety tests, then the Android unit-test/debug-APK gate unless `VERIFY_JS_ONLY=1` is explicitly set. JS-only success is not a full Android verification.
- Lint remains non-blocking because this environment lacks JDK 17, Gradle and Android SDK platform 34. Before enabling `abortOnError` and `checkReleaseBuilds`, run `gradle :app:lintRelease`, fix its findings, then rerun it cleanly.
- `tests/browser.test.js` is available via `npm run test:browser`, but is not wired into CI and its `puppeteer-core` / `@sparticuz/chromium` dependencies are intentionally not declared here.

## Code and safety

- `runTools()` now caps concurrent spawn/web batches at six; `tests/core.test.js` verifies twenty spawn calls never exceed that limit.
- Context compression is already present in the current code: `trimHistory()` replaces dropped turns with a structured `compactDigest`, and `tests/core.test.js` checks that earlier requests survive trimming. Explicitly pinning the current todo list/plan outside the history window remains unverified/open.
- Every model tool route remains behind `Safety.ensureApproved` / the approval rules and common tool executor. Keep bypass tests in `tests/safety.test.js` for any added route.

## Server inspection

`server/` is an optional Node backend, not another model-tool executor. It exposes authenticated API routes for file sync/read, command execution/cancellation, secrets, OAuth/Codex, Codex model requests, LSP, state and HTTP proxying. Health and registration are open routes; registration checks the configured access key and has rate limiting. The app's model tools still have their own approval gate before invoking the server.

The server stores user/OAuth/API secrets encrypted in SQLite using AES-256-GCM. Its data directory contains the database and master key; `server/data/` is ignored. By default the generated master key sits beside the database, so operators who need protection against a leaked data volume should set `CYB_MASTER_KEY` in the runtime environment. Runtime access keys and OAuth client secrets also come from environment variables, not source. The server's test and cross-user isolation suites remain the backend-specific tests; changes to the server's tool/API implementation need those tests as well as the app safety tests where tool routing changes. This task makes only ignore-file hygiene changes under `server/`.

## Open work

1. **Cleartext HTTP policy:** The requested Android Network Security Config cannot express arbitrary IPv4 CIDR ranges (10/8, 172.16/12, 192.168/16) as a domain allowlist. The current manifest still enables cleartext globally for LAN/custom providers. A correct solution needs a reviewed app-level policy/transport design that preserves private-LAN use while blocking public HTTP and redirects; do not silently replace the setting with a localhost-only allowlist or assume it works without device testing.
2. **Lint:** Run `gradle :app:lintRelease` with JDK 17 and Android SDK 34, resolve findings, then enable both blocking lint flags.
3. **MCP:** No MCP client/server adapter exists yet. Keep any future adapter behind the existing approval/untrusted-data path; do not add a second tool executor.
4. **Context pinning:** Structured history summaries exist, but an explicit current plan/todo pin outside the trimmed message window still needs design and a regression test.
5. **Client key storage:** Provider keys are in WebView storage on the phone. Consider Android Keystore-backed encryption for a future security-focused task.
6. **Crash reporting:** No crash-reporting integration exists. Any future opt-in telemetry must never collect prompts, files, keys or authorization headers.
7. **History cleanup:** The compromised old keystore remains in Git history and in any existing forks/clones unless separately purged; no rewrite was performed here.
