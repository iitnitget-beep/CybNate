# CybNate: Phase 1 audit and zero-budget roadmap

Date: 2026-11-14. Branch `arena/702e73e1-cybnate`. Nothing in the app was changed for this audit.

Evidence used: the source in this repository, the test suites, the emulator self test of build #30 (`release/selftest.txt`, 30 pass / 0 fail, Android 14), and a fresh clone of `github.com/CodebuffAI/codebuff` (the Freebuff source).

## 1. What the app is today

One Android activity hosting a WebView. All logic is vanilla JavaScript in `app/src/main/assets/www/`; Java provides a small bridge.

| Part | Files | Size |
|---|---|---|
| UI and agent loop | `app.js` | 1652 lines |
| Agents, tools, parser, ZIP/APK analysis | `core.js` | 1191 |
| Approval gate, checkpoints | `safety.js` | 197 |
| Router, model pool, limiter, budget | `orchestra.js` | 248 |
| GitHub over REST | `github.js` | 141 |
| Python (Pyodide) and JS workers | `pyworker.mjs`, `jsworker.js` | |
| Native bridge: HTTP without CORS, shell, file mirror, preview | `MainActivity.java`, `ShellRunner.java`, `PreviewPane.java` | 750 |

There is no backend of any kind. Everything runs on the phone and talks directly to model providers and GitHub.

## 2. Feature status

Classes: 1 implemented and tested · 2 implemented but incomplete · 3 UI only · 4 missing · 5 broken · 6 needs external infrastructure.

| Feature | Class | Finding |
|---|---|---|
| AI chat | 1 | Streaming, Markdown, history. Device-tested against Pollinations. |
| Coding agent | 1 | Real tool loop (read, write, edit, delete, run, search, web). Device test creates and runs a file. |
| Planner, Reviewer agents | 1 | Real prompts and tool sets; read-only rules enforced in code for helpers. |
| Reverse agent | 2 | Real APK/ZIP listing, manifest decoding, strings, hexdump. No decompiler (DEX→Java, native code). |
| Auto mode pipeline | 2 | Router, limiter, budget tested. Full Planner→Coder→Reviewer run tested only with fake models, not on a real provider. |
| Provider: Pollinations | 1 | Device-tested. Keyless tier: about one reply per 45 s. |
| Providers: OpenRouter, Groq, Gemini | 2 | Code paths exist and are unit-tested; never run with a real key in CI. The Groq tool-call fix is unverified. |
| Custom OpenAI-compatible endpoint (Ollama) | 2 | Works by URL; no model discovery for it, never tested against Ollama. |
| Model discovery, free filter | 2 | `/models` fetched per provider; OpenRouter filtered to free. No context-window data. Rate limits are hardcoded estimates. |
| GitHub | 2 | Clone and push through the REST API with a token (max 500 files, 400 KB each, one commit per push). No branches UI beyond choosing one, no pull, no diff viewer, no PRs. |
| Workspace and file manager | 1 | IndexedDB, mirrored to app storage for the shell. Import, export ZIP. |
| Editor | 2 | Plain `<textarea>`. No syntax highlighting while editing, no tabs, no search/replace. |
| Python | 1 | Pyodide in a worker. Pure-Python wheels and Pyodide packages only; no native pip packages, no sockets. |
| "Node.js" | 2 | Not Node. A worker with `require()` between workspace files and small `fs`/`path` shims. No npm packages. |
| Terminal | 2 | Runs the Android system shell (`/system/bin/sh`, toybox). No git, python, node, apt, compilers. One command at a time, no streaming output, no background jobs. |
| Web search, read URL | 2 | Works on device. Single search provider, no fallback chain yet. |
| Skills | 1 | Install from GitHub, edit, load on demand. |
| Safety (approvals, untrusted data, undo, preview isolation) | 1 | 10 device tests. |
| Local storage of keys and secrets | 2 | Plain localStorage inside app-private storage; backups disabled. Not encrypted with the Android Keystore. |
| Supabase | 4 | **Not present.** The only occurrence of "supabase" is the name of an installable skill in the catalogue. The earlier APK inspection misread this. |
| Coding-agent CLIs (OpenCode, Aider, OpenHands, Codex, Claude Code) | 4 | None. |
| Real Linux environment | 4 / 6 | None, and it cannot live inside this APK (see 4.2). |
| Accounts, sync, multi-user | 4 / 6 | None. |
| WebSocket streaming | 4 | The app uses HTTP streaming only. |

Nothing was found that is broken (class 5) or pure UI with no function (class 3) in the current build.

## 3. Freebuff / Codebuff repository

Source: `github.com/CodebuffAI/codebuff` (its README also names `CodebuffAI/freebuff`). TypeScript monorepo built with Bun.

| Area | Finding |
|---|---|
| License | Root `LICENSE` is Apache-2.0 and there is a `NOTICE` file. `freebuff/README.md` says "MIT". The root license is the safer reading; attribution and the NOTICE must be kept. |
| Layout | `cli/` (terminal UI, React + OpenTUI), `sdk/`, `packages/agent-runtime/` (agent step loop, tools, context compaction), `packages/llm-providers/`, `agents/` (agent definitions), `common/`, `freebuff/` (build and release of the CLI). |
| Models | The free models are served by Freebuff's own servers, paid for by text ads, behind a login. That server is not in the repository. The SDK also has a bring-your-own-key path (OpenRouter, OpenAI-compatible). |
| Tools | read/write files, str-replace, apply-patch, code search, glob, terminal command, web search, read URL, read docs, spawn agents, todos, skills, follow-ups, ask user. |
| Android | Not usable as is. It needs Bun, a native terminal UI and tree-sitter binaries. To my knowledge Bun has no official Android build; this needs checking before anyone relies on it. |

What can be reused, legally and technically:

| Component | Use in CybNate | How |
|---|---|---|
| Agent prompts and tool descriptions | Already done in v2/v3 | Text only, credited in `NOTICE` |
| Context compaction and conversation summary (`compaction*.ts`, `conversation-summary.ts`) | Replace our "drop old messages" trimming | Port the idea to plain JS |
| Tool-call JSON repair (`repair-tool-json.ts`) | Free models often emit broken JSON | Port, small |
| `apply-patch` and `propose-*` (review before apply) | Diff review on the phone | Port the idea |
| Agent definition format (`agents/*.ts`) | User-defined agents | Adopt the shape, not the code |
| MCP client (`mcp.ts`) | Tool servers | Reference for our own client |
| The CLI itself, the login, the ad system, the hosted models | Not reusable | Server-side or tied to their accounts |

## 4. Hard constraints that shape the plan

### 4.1 Zero budget
Every item below uses free tiers or the user's own hardware. Free tiers have quotas, change without notice and can end. The app must show what it knows about limits and never fall back to a paid model.

### 4.2 A real Linux environment cannot ship inside this APK
Android 10 and later refuse to execute files that an app downloads into its data folder when the app targets API 29 or higher; CybNate targets 34. That is why Termux stays on an old target API and is not on Google Play in its current form. So "real shell, git, python, node, java, packages" must run outside the app process. This also matches the brief's rule not to run untrusted code inside the app.

Free places it can run:

| Option | Cost | What the user must do | Limits |
|---|---|---|---|
| Termux on the same phone, running a small CybNate worker | Free | Install Termux from F-Droid, run one setup command | Phone CPU and storage; Android may stop background work |
| The user's own PC or any Linux box, worker in Docker or Podman | Free if they own it | Run one container, connect over LAN or a free tunnel | The machine must be on |
| GitHub Actions on the user's repository | Free allowance | Token with workflow permission | Not interactive, minutes are limited on private repositories, slow start |
| Free cloud VMs | Not dependable | Usually need a card and can be reclaimed | Not planned |

There is no free hosted service that will run arbitrary code for all CybNate users. Each user brings a worker; without one the app keeps working as it does today.

### 4.3 Coding-agent CLIs
OpenCode, Aider and OpenHands need Node, Python or Docker, so they run on the worker, never in the WebView. The app would speak the Agent Client Protocol to them through the worker where the agent supports it, and fall back to driving the CLI otherwise. Which agents support ACP today, and whether each installs under Termux, must be tested in Phase 4 before anything is claimed. Codex CLI and Claude Code need the user's own OpenAI or Anthropic account; they can be optional adapters but are not part of the zero-cost path.

### 4.4 Supabase
There is nothing to reuse, so this would be a new backend, optional by design: the app must stay fully usable offline and signed out. Supabase would hold accounts, chat and task history, project metadata and usage counters with row-level security; never model keys in readable form, never the service-role key in the app. The free tier has project, database and storage quotas and pauses inactive projects.

### 4.5 Editor
Monaco does not support mobile browsers according to its own documentation. CodeMirror 6 (MIT) does and is much smaller. The plan uses CodeMirror.

## 5. Roadmap (the brief's order)

| Phase | Work | Needs from you |
|---|---|---|
| 2. Model router | Read limits from response headers and 429 bodies instead of fixed numbers; context-window from provider model lists; Ollama discovery (`/api/tags`); per-model usage screen; strict "free only" guard with a visible reason when a model is refused | Optional: free keys for OpenRouter, Groq, Gemini so the paths can be tested for real |
| 3. Freebuff reuse | Port history compaction, tool-JSON repair, propose-then-apply edits; credit in `NOTICE` | Nothing |
| 4. Agent CLIs | Worker-side adapters behind one interface: detect, start session, stream, permissions through the existing approval sheet, resume | A decision on the worker (Phase 5 comes first in practice) |
| 5. Execution backend | `worker/`: small Node service with token auth, PTY sessions over WebSocket, workspace sync, timeouts and limits; Dockerfile; Termux install script; GitHub Actions build runner | Whether you have Termux or a PC to test on |
| 6. IDE | CodeMirror 6 editor with tabs, search, diagnostics from the worker; terminal tab; file tree; build/test buttons | Nothing |
| 7. Supabase | Schema, RLS policies, migrations, sign-in, opt-in sync | A Supabase project (free), its URL and anon key; you run the migrations or connect the project |
| 8. GitHub | Branches, pull, diff viewer, pull requests, larger repositories through the worker's real git | Nothing new |
| 9. Orchestration | Debugger, Tester, Security reviewer roles; task graph with dependencies; execution log | Nothing |
| 10. Security and tests | Keystore-backed secret storage, audit log, worker hardening, full test pass | Nothing |
| 11. Release | APK, deployment guide, limits list | Nothing |

Phases 4 and 5 depend on each other: the CLIs need the worker. I recommend building the worker (5) before the CLI adapters (4), and ask for your approval to swap them.

## 6. Not verified in this audit

- OpenRouter, Groq and Gemini were not called with real keys.
- Whether Bun, OpenCode, Aider or OpenHands install under Termux.
- Current free-tier numbers of any provider, GitHub Actions or Supabase.
- The app on a physical phone; all device evidence is from an emulator.
