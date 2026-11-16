# AGENTS.md — CybNate

## What this project is

CybNate is a free AI coding agent for Android. A WebView hosts the UI and JavaScript agent; Java provides the shell, file bridge, native HTTP and an isolated preview. See `README.md` for user-facing capabilities.

## Layout

- `app/src/main/assets/www/core.js` — model providers, agent/tool definitions, parsers, workspaces and `runTools()`.
- `app/src/main/assets/www/app.js` — UI, settings, agent loop, provider requests and integrations.
- `app/src/main/assets/www/safety.js` — permission modes, approval rules, sensitive-path rules, untrusted-data wrapping and checkpoints.
- `app/src/main/assets/www/orchestra.js` — routing, task pipeline, model pool and budgets.
- `app/src/main/assets/www/vendor/` — pinned third-party files; do not replace or add files without documenting exact versions.
- `app/src/main/java/com/cybnate/app/` — Android WebView host, native bridge, shell runner and preview.
- `server/` — optional authenticated backend, isolated workspace/command execution, LSP, OAuth and encrypted server-side secrets. Its runtime data belongs in ignored `server/data/`.
- `tests/` — Node unit, UI, preview, backend and safety tests.
- `scripts/verify.sh` — the verification gate. Run `npm ci` before the jsdom-backed UI or preview suites.
- `release/` — CI-published APK and device-test results. Keep the APK committed at `release/CybNate.apk` as requested.

## Verification

```sh
npm test
VERIFY_JS_ONLY=1 bash scripts/verify.sh
bash scripts/verify.sh
npm run test:ui
npm run test:preview
```

The full gate additionally requires JDK 17, Gradle and Android SDK platform 34. It runs `gradle :app:testReleaseUnitTest :app:assembleDebug`. A JS-only run is not evidence that the Android build passed. The emulator-only behavior is proven by the CI self-test output in `release/selftest.txt`, not by Node tests.

## Safety and security rules

1. Every model tool route must pass through the existing `Safety.approvalFor` / `Safety.ensureApproved` gate and the common `runTool` / `runTools` path. Do not add a separate executor.
2. Every tool result returned to a model must be wrapped with `Safety.wrapUntrusted` before it enters conversation history. `load_skill` is the deliberate exception for user-installed skills.
3. Never widen the read-only command list casually. Any change must add a bypass test in `tests/safety.test.js` proving dangerous routes are refused.
4. Do not weaken or delete tests, assertions, safety rules, or lint checks to make a build pass.
5. Never commit or log signing material, passwords, tokens, `.env` files, or base64 encodings of secrets. `keystore/` and server runtime data are ignored. The old signing key was exposed in repository history and must be considered compromised; do not restore or reuse it.
6. Model output and external content are untrusted. Keep path checks, approval gates, checkpoints and secret masking intact.
7. Do not add npm runtime dependencies to the Android app. `package.json` dependencies are test/development-only; keep `www/vendor/` pinned.
8. Do not force-push or rewrite history. Push only when explicitly authorized, and only to the active session branch.

## Signing

The release build uses the environment variables `CYBNATE_KEYSTORE_PATH` (default `keystore/cybnate.jks`), `CYBNATE_STORE_PASSWORD`, `CYBNATE_KEY_ALIAS` (default `cybnate`), and `CYBNATE_KEY_PASSWORD` (defaults to the store password). Without a valid private key and password, the release build falls back to debug signing. A debug-signed APK cannot update an installed app signed with a different key; it must be uninstalled first. With a JDK, create a private local key and obtain its base64 value with:

```sh
mkdir -p keystore
keytool -genkeypair -v -keystore keystore/cybnate.jks -alias cybnate \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 keystore/cybnate.jks
```

`keytool` prompts for passwords. Never put key material, base64 or passwords in this repository, logs or chat.
