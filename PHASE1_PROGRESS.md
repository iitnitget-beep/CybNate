# Phase 1 (safety) progress

Rollback point: tag `v3.4-baseline` (commit eaea03e).

- [x] a. Permission modes in Settings (Ask default, Auto-edit, Auto)
- [x] b. Approval gate in code (runTool / runTools), all call routes and sub-agents
- [x] c. Read-only command whitelist
- [x] d. Approval sheet (shell, edits with diff, delete, GitHub push)
- [x] e. Tool results wrapped in untrusted_data + system rule
- [x] f. Secrets only when a command names them
- [x] g. Checkpoint before each agent run + one-tap Undo
- [x] h. Risky-command prompt line replaced
- [x] Tests: tests/safety.test.js (bypass by 5 routes, injection page, checkpoint), core, ui smoke, browser e2e pass locally
- [x] Emulator self test on build #26: pass=24 fail=0 (17 old + 7 new). APK in release/ and Drive (CybNate-v4-phase1.apk)

## Follow-up after the Codex review of PR #1

- [x] P1 Preview isolated from the native bridge (separate WebView, no JS interface); test: preview.test.js + device self test
- [x] P1 Self test refuses to run unless workspace and chats are empty
- [x] P1 Secrets to model-run code: explicit consent sheet listing the names (secret-name sheet); also for typed terminal commands
- [x] P2 Stop reaches native shell commands (execAbort)
- [x] P2 Large shell output files kept on disk and reported, not deleted at next start
- [x] P2 App data excluded from Android backup / device transfer
- [x] Read-only whitelist audit (outside-workspace paths, writing/following/exec options, .git protected)
- [x] Undo warning for files over 5 MB
- [x] README safety section
- [ ] Emulator self test on the follow-up build

## Notes
