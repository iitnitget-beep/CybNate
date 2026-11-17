# Day 5 — Verification Baseline

Date: 2026-11-17  
Repository: `iitnitget-beep/CybNate`  
Baseline branch: `work/day5-baseline`  
Base branch: `main`  
Base commit inspected: `26ceededd59b96eb0dfce7bd74d5bf248d17093d`

## Important status distinction

This is a source and CI-configuration inspection, not a fresh execution of the tests. The GitHub connector used for this audit did not provide a local checkout or an executable CI runner. No tests were run as part of this Day 5 preparation.

## CI workflow inspected

File: `.github/workflows/build-apk.yml`

The workflow configures:
- Java 17
- Gradle 8.10.2
- Node.js 22
- Repository audit script
- Cleartext, core, safety, orchestration, router, devtools, engine and CLI tests
- Backend server and isolation tests
- npm-installed UI/integration/sign-in/backend/preview tests
- Pyodide vendor fetch
- Android release unit tests and release APK assembly
- Android API 34 emulator device tests

The workflow has repository write permission and publishes the APK and device-test artifacts back to the branch. It may consume GitHub Actions minutes. It has not been triggered by this preparation.

## Verification scripts inspected

### `scripts/verify.sh`
Runs:
1. `bash scripts/audit.sh`
2. `node tests/cleartext.test.js`
3. `node tests/core.test.js`
4. `node tests/safety.test.js`
5. Android build gate requiring JDK 17, Gradle, Android SDK platform 34, then `gradle :app:testReleaseUnitTest :app:assembleDebug`.

It supports `VERIFY_JS_ONLY=1`, but explicitly labels that path as not a full verification.

### `scripts/audit.sh`
Contains repository hygiene checks for tracked key material, Gradle password literals, workflow key handling, required docs, test scripts, manifest cleartext request guards, ignored secret patterns, server JavaScript syntax, and CI workflow gates.

## Latest device-test artifact inspected

File: `release/selftest.txt` at the base commit.

Observed contents:
- Android 14 emulator user-agent.
- 9 visible PASS records (shell/workspace, Python, NumPy, pip and Node).
- No terminal `CYBTEST DONE pass=... fail=... skip=...` summary in the currently fetched file.

The inspected commit diff for the same artifact shows that an earlier version contained `CYBTEST DONE pass=42 fail=0 skip=0`, but the latest commit removed that summary and many test records. Therefore the earlier 42-pass result is historical evidence only; it is not proof that the current artifact is complete or that the latest workflow passed.

The CI workflow's final device-test step requires a `CYBTEST DONE` line with zero failures. Current artifact content does not satisfy that visible completion requirement.

## Baseline test matrix

| Area | Source of truth | Day 5 result |
|---|---|---|
| Repository hygiene | `scripts/audit.sh` | Not executed |
| Core engine | `tests/core.test.js` | Not executed |
| Safety | `tests/safety.test.js` | Not executed |
| Cleartext URL policy | `tests/cleartext.test.js` | Not executed |
| Orchestration/router | CI workflow test list | Not executed |
| Backend workspace/execution | `server/test` and backend tests | Not executed |
| UI/preview/integrations | CI workflow test list | Not executed |
| Android unit/build | Gradle task in workflow | Not executed |
| Android emulator | `scripts/device-test.sh` | Not executed; current artifact incomplete |

## Environment requirements recorded from CI

- Node.js 22
- JDK 17
- Gradle 8.10.2 in GitHub Actions
- Android SDK platform 34
- npm dependencies installed with `npm ci`
- Android emulator API 34 for device testing

## Security findings carried forward

- Historical signing-key material was reported in repository history. Treat it as compromised and rotate/reissue through a controlled release process; do not reuse it.
- Local-mode provider keys were previously found in WebView localStorage; migrate to an OS-backed secure store or a carefully designed server-side secret broker.
- Backend execution isolation is conditional; the non-root path was previously observed to report no isolation. Do not expose this execution path as a public multi-tenant service until fixed and tested.
- Android cleartext traffic remains enabled for local-network compatibility; preserve and test all request and redirect URL guards until a stricter network policy is implemented.

## Next action

Obtain a fresh, complete baseline run in an authorized development environment. Record the exact commit SHA, environment versions, command, exit code, test totals, Android artifact checksum and device-test completion marker before any engine refactor.
