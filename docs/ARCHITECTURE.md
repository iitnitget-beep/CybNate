# CybNate Architecture Baseline

Status: planning document, Day 5 preparation  
Baseline branch: `work/day5-baseline`  
Production branch: `main` (do not modify directly)

## Current architecture observed in the repository

### Android client
- Kotlin Android application with a WebView-hosted coding workspace.
- Native bridge exposes selected file, shell, HTTP, and preview capabilities.
- `PreviewPane` uses a separate WebView; project preview code should remain isolated from the privileged native bridge.
- Local project/workspace state is synchronized between the web UI and Android-side storage.

### Coding engine
- `app/src/main/assets/www/core.js`: workspace and file tools, tool parsing/execution, agent definitions, prompts, and coding utilities.
- `app/src/main/assets/www/orchestra.js`: model routing, provider selection, budgets, rate limits, task stages, and helper-agent write restrictions.
- `app/src/main/assets/www/safety.js`: approval policy, sensitive operations, untrusted-data handling, and checkpoints.
- `app/src/main/assets/www/github.js`: GitHub repository operations.
- `app/src/main/assets/www/app.js`: application UI and orchestration integration.

### Optional Node backend
- `server/src/app.js`, `workspace.js`, `store.js`, `http.js`, `net.js`, `exec.js`, `oauth.js`, and `lsp.js`.
- This is an optional backend foundation, not yet a complete production multi-tenant cloud coding service.

## Target architecture (incremental; not yet implemented)

1. **Client and workspace UI** — Android first, responsive web client later.
2. **Identity and project authorization** — authenticated user, project ownership, explicit permissions.
3. **Orchestration gateway** — normalized task/run/event API; model and harness adapters; budgets and cancellation.
4. **Policy and approval service** — tool allowlists, path boundaries, secret handling, approval receipts, audit trail.
5. **Isolated execution provider** — one isolated workspace per trust boundary; restricted network; CPU, memory, time and storage limits.
6. **Code intelligence** — Tree-sitter parsing, symbol index, incremental invalidation, language-server diagnostics.
7. **Artifact and preview service** — isolated preview origin, build outputs, logs and screenshots.
8. **Persistence and observability** — resumable run state, checkpoints, structured events, metrics and retention policy.

## Non-negotiable security boundaries

- Never run untrusted agent-supplied executable templates with in-process `eval`.
- Do not treat a publisher trust flag as a sandbox.
- Never expose application, GitHub, billing or provider secrets to generated project code.
- Do not share a writable execution environment between unrelated users.
- Preview code must not inherit the privileged app origin, cookies or native bridge.
- Validate workspace paths after normalization and enforce ownership on the server.
- Restrict outbound network access and protect against SSRF and metadata endpoints.
- Require explicit approval for destructive operations, credential access and production deployment.
- Keep logs useful but redact tokens, passwords and private key material.
- Treat historical signing-key material in Git history as compromised; do not reuse it.

## Integration choices

- Preserve CybNate's current engine and improve it incrementally.
- Evaluate Tree-sitter and Android-compatible bindings behind a parser interface.
- Add structured agent definitions and typed tool schemas.
- Add a proposal/diff/apply flow before broadening autonomous writes.
- Add durable run events and recovery checkpoints.
- Keep execution providers pluggable: local development first; hosted sandbox only after explicit cost approval.
- Evaluate OpenHands as an architecture reference and adapter candidate, not as an automatic wholesale replacement.

## Deployment and cost policy

Development and testing must use free/local resources wherever practical. Do not create paid infrastructure, enable paid APIs, attach billing, or deploy a hosted sandbox without the user's explicit approval.
