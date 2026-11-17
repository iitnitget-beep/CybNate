# Day 9 — Read-only Project Inventory Foundation

Date: 2026-11-17
Branch: work/day9-project-inventory
Base: main at 7b483f06334c2190e5daaadc93be14b86b75bbdb

## Repository and CI checkpoint

- PR #4 (Work/day5 baseline) is merged into main.
- Workflow #65 completed successfully: build and device-test jobs both passed.
- Workflow #66 completed successfully: build and device-test jobs both passed.
- GitHub Actions published a complete device report: 42 pass, 0 fail, 0 skip.
- The Day 8 audit document exists on the previous work branch but was not present on main when this branch was created. This branch therefore starts from the current main head and does not assume the old branch is authoritative.

## Implemented on this branch

- Added `project-index.js`, a dependency-free, read-only inventory utility.
- Added `tests/project-index.test.js` with cases for path traversal, absolute paths, excluded directories, malformed package manifests, unsupported file handling, per-file limits, total-byte limits and file-count limits.
- Added the new test file to the root `npm test` chain.

## Safety properties

- Does not execute project code, shell commands, package scripts or build tools.
- Does not follow filesystem links; it consumes caller-provided path/content records only.
- Rejects absolute paths, drive-letter paths, parent traversal, NULs and empty path segments.
- Skips common generated/dependency directories.
- Bounds inventory by file count, individual file size and total bytes.
- Records only paths, languages, sizes, manifest names, entry-point candidates and declared test command strings. It does not execute those commands.
- Malformed package.json is reported as a warning, not a crash.

## Deliberate limitation

This is the inventory engine foundation only. It is not yet wired to the live workspace or agent prompt, and it is not a persistent index or Tree-sitter symbol graph. That integration is the next step after this isolated module passes CI.

## Verification

- Source files and test cases committed to the feature branch.
- Local execution was not available through the connected GitHub repository tools; therefore these new tests are not yet claimed as passed.
- The CI run triggered by this branch must execute the root test command before this implementation is considered verified.
- No paid services, API usage, cloud resources or production settings were enabled.

## Actions failure investigation and correction

- Run #70 built the APK successfully; the device report had 41 passes and one failure.
- The only reported failing test was a direct unauthenticated GitHub repository API request returning HTTP 403. This is an external API/rate-limit condition, not an APK build failure.
- Updated the CORS test to call GitHub's rate-limit endpoint and to report a clearly identified GitHub rate-limit response as SKIP, while still failing unexpected HTTP/CORS errors.
- Added `project-index.test.js` to the CI Node test loop. Previously it was present in `npm test` but the workflow's explicit test loop did not invoke it.
- Added a 120-second startup watchdog to the emulator script. If the app never emits `CYBTEST START`, it now saves logcat/screenshot diagnostics and fails early instead of waiting the full 32-minute suite timeout.
- Kept `cancel-in-progress: true`; the cancelled runs #67 and #68 were caused by multiple quick commits to the same branch. Future changes are being batched into one commit to avoid creating extra superseded runs.
- These corrections are committed on the feature branch only. The new Actions run must verify them; no new pass result is claimed yet.
