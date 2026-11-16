# CybNate

A free AI coding agent for Android, inspired by [Freebuff](https://github.com/CodebuffAI/freebuff).
No account, no subscription, no ads. It talks directly to free model providers from your phone.

**Download:** [`release/CybNate.apk`](release/CybNate.apk) (rebuilt by GitHub Actions on every push).

## What it does

CybNate follows the same working loop as Freebuff's main agent: gather context, plan, edit, run, review, fix, summarise.

| Capability | How it works on the phone |
| --- | --- |
| Read, search, write and edit files | Project workspace stored on the device |
| Run terminal commands | Android shell for `ls`, `grep`, `sed`, `find`, `tar` and so on; real CPython 3.14 (Pyodide) for `python`, `pip install`; a JavaScript runtime for `node file.js` |
| Web project previews | Multi-file React/JSX/TSX with Tailwind CSS and React Native Web, compiled by Babel Standalone with `esm.sh` import maps; virtual Express `/api/*` routes for full-stack previews |
| Helper agents | `explorer`, `thinker`, `reviewer`, `researcher`, each with its own context; several run in parallel |
| Web search and page reading | DuckDuckGo results and readable page text |
| GitHub | Clone a repository into the workspace, commit and push from the GitHub screen (no git binary needed) |
| Task checklist and next-step suggestions | Shown in the chat |
| Reverse engineering | File type and headers, SHA-256, entropy, strings, hex dump, ZIP/APK listing and extraction, `AndroidManifest.xml` decoding |

Agents you can pick: ⌨ Coder (the orchestrator), 🧭 Planner, 🔍 Reviewer, 🧬 Reverse, 💬 Chat.
There is also a Terminal screen for running commands yourself, an editor, and an isolated preview for HTML and multi-file React projects (JSX/TSX), Tailwind CSS, and React Native Web. Babel compiles project components in the preview; `esm.sh` import maps provide browser packages, and Virtual Express handles `/api/*` routes without opening network sockets.

## Model providers

| Provider | Key | Notes |
| --- | --- | --- |
| Pollinations | none | Default. Works immediately. |
| OpenRouter | API key | Free models are selected by price metadata; paid/unknown-price models require explicit opt-in. |
| Groq | API key | Account usage and limits depend on Groq. |
| Google Gemini | API key | Account usage and limits depend on Google. |
| NVIDIA NIM | NVIDIA API key | OpenAI-compatible API. Model calls are blocked until **Allow paid models** is enabled because account credits/pricing may vary. |
| Custom | optional | Any OpenAI-compatible server, e.g. Ollama on your PC |

Tap the model name above the message box to pick a model; **↻ Refresh** loads the provider's current list. Provider keys are saved in the app's local settings and requests go directly from the app to the provider. Check each provider's terms, billing and rate limits; the app cannot know the balance on your account.
Agent quality depends heavily on the model: add a key for a provider/model that suits your task, or keep using Pollinations without a key.

## Differences from Freebuff

- Freebuff's hosted models are not used; they run on Freebuff's ad-funded servers.
- No native Node.js server or real network sockets. JavaScript runs in a constrained runtime; its virtual Express preview supports `/api/*` route verification in memory only.
- React/JSX/TSX, Tailwind CSS and React Native Web are supported in isolated previews using Babel Standalone and `esm.sh` import maps; these are preview features, not a full native `npm`/Node.js toolchain. Python packages must be pure Python or part of the Pyodide distribution.
- Python and JavaScript run in their own runtimes, so they cannot be piped into shell commands.
- Ghidra is a desktop Java program and does not run inside the app. Decompile on a PC, then import the output for the Reverse agent.
- No browser automation and no desktop/cloud products.

## Build

The workflow in `.github/workflows/build-apk.yml` builds a release APK and commits it to `release/CybNate.apk`. Until all signing secrets are configured, the APK is **debug-signed** and cannot update an installed app; users must uninstall the old-signed copy before installing it. Once configured, CI restores the private key from GitHub Actions secrets and does not commit it.

Locally, with JDK 17 and Android SDK 34:

```sh
mkdir -p keystore
keytool -genkeypair -v -keystore keystore/cybnate.jks -alias cybnate \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 keystore/cybnate.jks
```

`keytool` prompts for the passwords; do not put them in commands or source files. Store the base64 output as `CYBNATE_KEYSTORE_BASE64`, and set `CYBNATE_STORE_PASSWORD` and `CYBNATE_KEY_PASSWORD` in GitHub → Settings → Secrets and variables → Actions. The environment variable `CYBNATE_KEYSTORE_PATH` can override the default key path for local builds.

## Safety (v4 Phase 1)

The rules below are enforced in code (`safety.js`, `core.js`), not by the prompt, and apply to every route a model can use to call a tool, including sub-agents.

**Permission modes** (Settings → General → Permissions)

| Mode | File changes | Shell commands | Deletes |
|---|---|---|---|
| Ask (default) | ask, one sheet per step with diffs | ask, except read-only ones | ask |
| Auto-edit | automatic | ask, except read-only ones | ask |
| Auto | automatic | automatic | automatic |

In every mode, these always ask: changes to protected files (`.github/`, `.git/`, `NOTICE`/`LICENSE`, `.env*`, key and settings/secrets files), commands that name such a file or the app's private data, commands that receive a secret, and every GitHub push.

- **Approval sheet**: Allow once / Always allow in this chat (exact command or prefix only; never for delete, push, secrets or protected files) / Deny. Sheets appear one at a time; Stop cancels pending ones and ends a running shell command; Back means Deny.
- **Read-only commands** run without asking: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `diff`, `stat`, `file`, `du`, `df`, `tree`, `date`, checksums, `git status|diff|log|show`. A command is never read-only if it has a pipe, redirect, `;`, `&&`, `$(...)`, backticks, an absolute, `~` or `..` path, or an option that writes a file, follows a file or starts another program.
- **Untrusted data**: every tool result is wrapped in `<untrusted_data source="...">`. The model is told that such text is information, never instructions. This cannot stop a model from *trying* to follow injected text; the approval gate is what stops the command.
- **Secrets**: no run gets secrets by default. The agent must name them (`secrets="NAME"`), and the sheet lists the names. Code that you allow to receive a secret can read it and send it anywhere; masking only covers printed output.
- **Undo**: a checkpoint is taken before each agent run; one tap restores changed and deleted files and removes new ones. Limits: 5 MB per file, 40 MB in total. Larger files are not covered, and the app says so next to the Undo button.
- **Preview**: workspace HTML opens in a separate WebView with no native bridge and a different origin, so a previewed page cannot run shell commands or touch files.
- **Backups**: app data (keys, secrets, chats) is excluded from Android cloud backup and device transfer.
- **Self test**: runs only when the workspace and chats are empty, because it clears the workspace.

Not covered: in Auto mode, ordinary shell commands run without asking, so use it only for projects you trust.

## Auto mode (Phase 2C)

Auto is the default agent. It decides who should handle a request and, for code changes, runs a small pipeline. The logic is in `orchestra.js` (no DOM, tested under Node).

- **Router**: rules first, no model call. APK/DEX/ELF files or "analyse/decompile" → Reverse; a plain question → Chat; "plan/design/kaise karein" → Planner; a change or bug fix → Coder. Only an unclear request costs one small model call. The chip ("Auto → Coder ▾") shows the choice; tap it to run the same request with another agent.
- **Pipeline** for code changes: Planner → Coder → Reviewer → Coder fix, with at most one review round. Small tasks skip the Planner; the review is skipped when no file changed. The last run of the code or tests is the proof and is shown in the timeline.
- **Models per role** from every provider you can use: Planner/Thinker get a reasoning model, the Coder keeps the model you picked, the Reviewer comes from a different model family when one is available, Explorer/Researcher/Router get a small fast one. Each role has a fallback chain of three; results are remembered, and a model that just failed is tried last for ten minutes.
- **ask_agent** (same tool as `spawn_agent`): explorer, thinker, reviewer, researcher, planner, reverse, chat. Depth 1, at most 3 asks per task. Only the Coder changes files; Reverse may write under `analysis/`; file changes a helper makes through the shell are undone.
- **Limits**: per provider at most 2 requests at once, a requests-per-minute bucket (OpenRouter 20/min) and a daily counter of this app's own requests. These are cautious estimates of the free tiers, not values read from the provider. When little is left, or on the keyless Pollinations tier (one reply every 45 s), Auto runs a single agent.
- **Task budget**: 30 model requests per task by default (Settings → General). The timeline shows "requests used: N/30"; at the cap the run stops and reports what was done.
- **Safety**: helpers pass through the same approval gate, approval sheets appear one at a time, shell commands run one at a time, and every helper report reaches the next agent inside `<untrusted_data>`.

## Model router (Phase 2)

- **Cost safeguards.** On OpenRouter a model is called only if the price list says it costs nothing or its id is a `:free` variant; anything else is refused before a request unless "Allow paid models" is enabled. NVIDIA model calls are also blocked until that setting is enabled because NVIDIA account credits/pricing may vary and its model list does not reliably identify free access. Groq, Gemini, Pollinations and custom servers are billed/limited according to the account or server; the app cannot see those balances, so check their terms before using a key.
- **Limits are learned, not assumed.** The app starts at a careful pace and then follows each provider's replies: `retry-after`, `x-ratelimit-*` headers and wait hints in error bodies. A short wait is honoured; a wait longer than 90 s makes the request fall back to the next model. The daily figures in the code are estimates that only trigger the "running low" warning.
- **Context window.** Where a provider publishes it (OpenRouter, Groq), the chat history sent is sized to the smallest window in the fallback chain, and small-window models rank lower for agent roles.
- **Local models.** The Custom provider accepts an Ollama address with or without `/v1`; the model list is read from `/v1/models` or `/api/tags`, and local models join the Auto pool.
- **Usage & limits** (Settings) shows, per provider, the current pace and where it came from, what the provider reported, any wait in force, and today's requests, failures and tokens per model.

## Tests

Install the test-only dependencies with `npm ci`, then run `npm test` for core, safety and provider-router tests. `npm run test:ui` and `npm run test:preview` run the other jsdom suites. The Android verification gate is `bash scripts/verify.sh`; use `VERIFY_JS_ONLY=1 bash scripts/verify.sh` only when the Android toolchain is unavailable (that is not a full Android pass).

```
node tests/core.test.js        # tools, parser, commands, ZIP, APK analysis
node tests/safety.test.js      # approval gate, bypass routes, injection page, checkpoint
node tests/preview.test.js     # preview never runs next to the native bridge; Stop reaches the shell (needs jsdom)
node tests/orchestra.test.js   # router, pipeline, limiter, budget, model pool, helper write rules
node tests/router.test.js      # model router: rate-limit headers, back-off, free-only guard, context budget
node tests/router.ui.test.js   # the same inside the app with fake provider servers (needs jsdom)
node tests/auto.test.js        # Auto mode end to end with fake models (needs jsdom)
node tests/ui.smoke.js         # UI + agent loop in jsdom (needs jsdom)
node tests/browser.test.js     # full run in headless Chromium with real Python (needs puppeteer-core, @sparticuz/chromium)
TOK=<token> node tests/github.test.js
gradle :app:testReleaseUnitTest   # shell runner
```

CI also installs the APK on an Android emulator and runs the in-app self test; results are in `release/selftest.txt`.

## Layout

- `app/src/main/assets/www/` – the app: `core.js` (agents, tools), `app.js` (UI, agent loop), `pyworker.mjs`, `jsworker.js`, `github.js`
- `app/src/main/java/…/` – WebView shell, shell runner, file import/export, native HTTP
- `scripts/fetch-vendor.sh` – downloads the Python runtime and Babel Standalone compiler at build time

Third-party: marked, DOMPurify, highlight.js, Pyodide. CybNate contains no Freebuff code; its agent workflow is modelled on Freebuff's (Apache-2.0).
- Interface: neutral dark theme with a card composer, mode and model selectors, drawer and a settings list (General, Model Providers, Appearance).
- Agent guidelines adapted from Codebuff/Freebuff (Apache-2.0), see `NOTICE`. Models receive native function definitions, with a text-tag fallback.
