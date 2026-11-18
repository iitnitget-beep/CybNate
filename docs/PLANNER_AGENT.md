# Structured Planner Agent

## Scope and architecture

Auto mode's existing `planner → coder → reviewer → coder fix` pipeline now asks the existing read-only Planner helper for a JSON plan on multi-stage coding requests. `planner.js` is a DOM-free validator used by both the WebView and Node tests. It accepts a bounded task list, validates fields and identifiers, checks dependency references and cycles, and canonicalizes tasks with a stable topological order. The plan is included in the conversation as untrusted data; the Coder is instructed to follow its dependency order.

The Planner does not get a new executor, filesystem write path, approval bypass, tool API, or persistence layer. Actual implementation remains in the existing main Coder loop. All tool calls continue through Core validation, Safety approvals, cancellation/deadline handling and the existing workspace/checkpoint flow. The timeline displays planning/replanning status, and a validated plan is shown as a minimal in-conversation report.

## Validation and bounded recovery

The app allows one validation retry if the model response is malformed or fails schema/graph validation. If both attempts fail or the helper fails, the request continues with the original user prompt and no structured plan; the UI labels the fallback. After a coder tool batch has failures, and only if the user did not deny an operation, the app can request one revised plan and perform one additional Coder pass. Invalid/unavailable replans are not retried. Cancellation and request-budget errors propagate through the current request lifecycle and stop the run.

Plan input is untrusted. The local validator limits plans to 24 tasks (the prompt asks for 1–12), task text lengths are bounded, unknown keys are rejected, and there are no executable command fields. Dependency ordering is deterministic. Tool success/failure, approval decisions and verification output remain authoritative; a model's plan cannot mark a tool operation as successful.

## State and limitations

Plans are transient in-memory conversation content, not durable run records. They are not written to local or server storage as a separate object, are not resumable as structured state, and are not guaranteed to survive conversation deletion or compaction. Existing conversation history may include their textual report. Validation establishes schema and dependency consistency only; it does not establish that tasks are correct, complete, secure, or feasible. The model may still ignore or misunderstand the advisory plan. The planner is not a deterministic scheduler and does not individually gate each Coder tool call on completion of a task. Replanning is limited to one attempt after a failed tool batch; it does not promise automatic recovery or completion. Existing user approvals, cancellation, request budgets and proof-of-work behavior are unchanged.

No backend change is required: Task 02 does not add persistence, remote execution, or paid services.

## Tests

`node tests/planner.test.js` runs 28 deterministic, offline cases covering parse modes, schema and size bounds, dependency resolution and ordering, malformed/cyclic plans, formatting semantics, and replan limits. Auto mode integration tests cover plan handoff and a failure-triggered replan; the existing browser/UI suites cover app startup and rendering.
