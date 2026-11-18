# Planner Agent

## Purpose

The Planner is a bounded, advisory planning layer for complex Auto-mode coding requests. It creates a structured JSON plan and validates it before exposing the plan to the Coder. It does not execute plan steps itself and does not replace the existing Coder/tool execution loop.

## Runtime flow

1. Auto mode routes the request using the existing router and project file list.
2. For multi-stage coding requests, the Planner receives the user request and a bounded workspace file list.
3. The Planner returns JSON. `planner.js` parses and validates the object before it is accepted.
4. The validated plan is shown in the activity/report UI and supplied to the existing Coder as advisory context.
5. The Coder continues to use the existing tool registry, approval gates, cancellation signal, checkpoints and proof-run behavior.
6. If the Coder records a new tool failure and the request budget allows it, Auto mode may request one revised plan and one bounded Coder retry.

## Plan contract

A plan contains a request and plan identifier, user goal, project context, assumptions, risks, overall status and ordered steps. Each step has a unique ID, title, description, assigned agent, required tools, input, expected output, dependencies, affected relative paths, risk level, verification criteria and status.

Limits are enforced for the number and size of steps, text fields, dependencies, files, assumptions, risks and tools. Agent and tool names are checked against the runtime registries supplied by Auto mode. Relative paths reject absolute paths, drive-prefixed paths, empty path segments and parent traversal.

## Dependency handling

The validator rejects missing dependencies, self-dependencies and cycles. A stable topological order is produced. Step-status transition helpers reject illegal transitions and mark pending downstream steps blocked after an upstream failure, block or cancellation.

The current Auto-mode integration does not use this status helper to orchestrate each plan step. Dependencies are validated and represented as advisory instructions for the Coder; the Coder's actual tool execution remains authoritative.

## Replanning

At most one replan is allowed per task. It is triggered only after observed tool-failure evidence and when sufficient request budget remains. A revised plan is revalidated against the current agent and tool registries. Invalid replans are discarded; the original request and observed tool results remain the source of truth.

## Safety and trust boundaries

- Model-generated JSON is untrusted until schema validation succeeds.
- A validated plan is not proof that any file was inspected, changed or tested.
- The Planner does not receive direct write authority from this module.
- Actual edits remain subject to the existing Coder tool permissions, safety approvals, path checks, checkpoints and cancellation.
- Plan data is held in the active in-memory task/session; there is no durable structured plan store, cross-device sync or background plan execution.

## Known limitations

- Plans are advisory, not a deterministic workflow engine.
- The current integration does not schedule independent steps in parallel.
- It does not persist structured plans across app restarts or devices.
- It does not independently verify each step's stated verification criteria.
- A successful model response does not establish correctness; actual tool results and proof runs are required.
- Android build and runtime behavior must be confirmed by CI/device testing.
