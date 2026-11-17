# CybNate Production Readiness Gate

Audit date: 2026-11-17
Audited ref: main at 1b68d84ae94479821204a2a00d40b030791b2de6
Status: NOT PRODUCTION READY

This document records verified release blockers from source inspection. A passing CI build is necessary but is not proof of production security or operational readiness.

## Verified blockers

### P0 — Execution isolation is not guaranteed
- `server/src/exec.js` runs user commands through a shell.
- Workspace UID/GID isolation is delegated to `workspace.ids(user)`; the existing test workflow only explicitly exercises cross-user isolation under `sudo`.
- The server must refuse to start in a multi-user/remote mode unless every command is isolated by a verified OS/container boundary. Never silently fall back to shared host execution.

### P0 — Backend CORS is wildcard
- `server/src/app.js` currently sends `Access-Control-Allow-Origin: *`.
- Before public deployment, replace this with an explicit configured origin allowlist, reject credentialed wildcard configurations, and test preflight/denied origins.

### P0 — Android cleartext traffic is enabled
- `app/src/main/AndroidManifest.xml` sets `android:usesCleartextTraffic="true"`.
- Production release must default to HTTPS-only. If local development requires HTTP, scope it to debug builds or an explicit developer setting with tests.

### P1 — Master-key fallback is colocated with encrypted data
- `server/src/store.js` creates `master.key` inside the data directory when no environment key is supplied.
- This protects database contents at rest only while the key remains separate from the database file; a copied data directory contains both. Production mode must require an externally managed 32-byte key and fail closed if absent.

### P1 — GitHub Actions build workflow has write permissions
- `.github/workflows/build-apk.yml` declares repository-wide `contents: write` to publish generated APK and test artifacts back to the branch.
- Separate build/test from artifact publishing, minimize token permissions, and ensure untrusted pull-request code never receives signing secrets or write-capable tokens.

### P1 — Signing and release provenance need verification
- The workflow can fall back to a debug-signed APK when signing secrets are missing.
- A release candidate must fail closed when a signed release is expected, verify certificate fingerprint and package/version metadata, and publish checksums/provenance. Never present a debug-signed artifact as an installable upgrade release.

## Passed evidence at audit time
- GitHub Actions run 44113585719 completed successfully on merge commit 1b68d84ae94479821204a2a00d40b030791b2de6.
- Both `build` and `device-test` jobs completed with conclusion `success`.
- The device self-test report recorded 39 passes, 0 failures and 4 skips. Live model interactions were among the skipped checks.

## Release gates still required
1. Enforce fail-closed execution isolation and prove it with adversarial multi-user tests.
2. Add origin allowlisting, CSRF/session protections where applicable, request size/rate limits, and security-header tests.
3. Make Android release HTTPS-only and validate all WebView/native bridge trust boundaries.
4. Require externally supplied production encryption keys; document rotation, backup and recovery.
5. Split CI permissions and protect signing secrets; verify release signing and artifact provenance.
6. Run dependency/SBOM and secret-history scans; rotate any exposed credentials/signing material.
7. Validate Firebase Auth/Firestore/Storage rules and real device sign-in/data isolation against the configured project.
8. Validate production hosting, backups, monitoring, incident response, privacy disclosures and data deletion.
9. Run independent security review and production-like load/recovery tests.

## Scope and limitations
This is a source-level readiness audit, not a penetration test. It does not establish that a production server, Firebase project, OAuth provider, backups, monitoring or deployment is configured. No paid resources were enabled and no production deployment was performed.
