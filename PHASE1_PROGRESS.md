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
- [ ] Emulator self test + APK build on the new code

## Notes
