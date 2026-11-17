# Day 8 — Agent Orchestration and Project Intelligence Audit

Date: 2026-11-17
Branch: work/day5-baseline

## Scope

This is a source-level audit of the existing CybNate agent engine. It does not claim a new code-intelligence implementation or a live multi-agent execution test.

## Existing capabilities confirmed in source

- `core.js` defines tool groups for filesystem read/write, execution, web research, metadata, binary analysis and final responses.
- The agent registry includes a coordinator/coder, planner, reviewer and specialist helper agents.
- `orchestra.js` contains model-role assignment, fallback/health handling, request limits, helper-agent write restrictions and orchestration pipeline logic.
- Helper write restrictions are enforced in the tool execution path, not only described in prompts. Planner/reviewer/explorer and several other helpers are read-only; the reverse helper is restricted to the `analysis/` path.
- Helper outputs are formatted as untrusted data before being returned to the main agent.
- Existing tests cover role assignment, model fallback, helper permissions, parallel helper execution and injection-resistant result wrapping.
- Safety tests cover approval gates, protected paths, shell command classification, untrusted web content and workspace checkpoints.

## Gaps and limitations

1. No dedicated persistent semantic code index or Tree-sitter-backed symbol graph was verified in this audit.
2. Existing helper parallelism is not proof of isolated workspaces. Helpers may share the same workspace context; do not treat them as security sandboxes.
3. Prompt instructions are not enforcement. Every new agent capability must have tool-level authorization and fail-closed behavior.
4. Model-family diversity and fallback selection are heuristics; they do not guarantee independent reasoning or correctness.
5. A successful agent response must remain distinct from verified project execution. Tests, diagnostics and changed-file evidence should be attached to the run record.

## Day 8 architecture decision

Preserve the current engine and add capabilities incrementally:

1. **Project inventory:** collect file paths, language/config metadata, entry points, package manifests and test commands.
2. **Symbol intelligence:** evaluate Tree-sitter parsing behind a language adapter; begin with JavaScript/TypeScript, Kotlin and Python. Parsing failures must fall back to text search.
3. **Task context pack:** provide agents with relevant files, symbol references, project conventions and test commands, with explicit size limits.
4. **Proposal-first edits:** generate per-file diffs, validate paths and protected-file rules, then use the existing approval/checkpoint mechanism.
5. **Verification record:** capture commands, exit codes, diagnostics, changed files and test outcomes. Never equate model completion with task completion.
6. **Agent isolation (later):** if parallel agents need writes, give each a separate worktree or isolated workspace and merge reviewed patches through a controlled gateway. Do not add in-process executable agent code.

## Acceptance criteria for the first implementation

- Indexing is read-only and cannot execute project code.
- Unsupported or malformed files do not crash indexing.
- File paths are normalized and confined to the workspace.
- The index can be invalidated/rebuilt after edits.
- Agent tools remain least-privilege; helper read-only restrictions are enforced in code.
- Indexing can be disabled and text-search fallback remains available.
- Unit tests cover path traversal, malformed files, large files, stale index invalidation and unsupported languages.

## Verification status

- Source inspection: completed.
- Existing core/orchestration/safety tests: previously passed in GitHub Actions run #65 for this branch.
- Day 7 emulator job: still running at the time of this report; overall workflow not yet complete.
- New code: none in this Day 8 audit.
- Paid infrastructure: none enabled.

## Next step

Day 9: design and implement a small, read-only project inventory/index interface, starting with tests and without introducing a new native or cloud dependency until compatibility is proven.
