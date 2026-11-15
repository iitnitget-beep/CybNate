# Phase 1 (safety) progress

Rollback point: tag `v3.4-baseline` (commit eaea03e).

- [ ] a. Permission modes in Settings (Ask default, Auto-edit, Auto)
- [x] b. Approval gate in code (runTool / runTools), all call routes and sub-agents
- [x] c. Read-only command whitelist
- [ ] d. Approval sheet (shell, edits with diff, delete, GitHub push)
- [x] e. Tool results wrapped in untrusted_data + system rule
- [ ] f. Secrets only when a command names them
- [ ] g. Checkpoint before each agent run + one-tap Undo
- [x] h. Risky-command prompt line replaced
- [ ] Tests: bypass (3 routes), injection page, core, ui smoke, emulator self test, APK build

## Notes
