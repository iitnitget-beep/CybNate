# Phase 2: model router

Cost: zero. No new dependency, no server. Works on the same APK (Android 7+).

## What changed

| Area | Before | Now | Files |
|---|---|---|---|
| Paid models | OpenRouter list filtered to free, but a typed-in id was sent as is | Refused before any request unless the price list says free or the id is a `:free` variant; "Allow paid models" switch, off by default | `orchestra.js` `freeCheck`, `app.js` `chatStreamOne`, `modelPool` |
| Rate limits | Fixed numbers per provider; a fixed daily number stopped requests | Pace starts from an estimate and follows `retry-after`, `x-ratelimit-*` and wait hints in error bodies; daily figures only warn | `orchestra.js` `createLimiter.observe`, `parseRateHeaders`, `retryHintMs` |
| Long waits | Waited up to 90 s, then failed | A wait above 90 s moves on to the next model in the chain at once; alone, the user is told how long | `app.js` `chatStream`, `chatStreamOne` |
| Response headers | Not available to the app | Passed from `fetch` and from the Java bridge (only `retry-after` and `*ratelimit*`) | `app.js` `httpStream`, `nativeStream`; `MainActivity.java` |
| Context window | Fixed 70,000 characters of history | Sized to the smallest known window in the fallback chain; unknown window keeps 70,000 | `orchestra.js` `historyBudget`, `parseModelMeta`; `app.js` `apiHistory` |
| Ollama | Only `/v1/models` | Falls back to `/api/tags`; local models join the Auto pool | `app.js` `fetchModels` |
| Visibility | One line in Settings | Settings → Usage & limits: pace and its source, provider-reported quota, waits, per-model requests, failures, tokens, health | `app.js` `usageReport`, `openUsage` |

Storage added: `cyb.seen` (learned limits), `cyb.usage` (today's counts), `settings.meta`, `settings.allowPaid`.

## Test results

| Suite | Result |
|---|---|
| `tests/router.test.js` (new) | pass |
| `tests/router.ui.test.js` (new, app in jsdom with fake provider servers, 7 sections) | pass |
| core, safety, orchestra, auto, ui.smoke, preview | pass |
| Emulator self test, build #32, Android 14 | 32 pass, 0 fail (the earlier 30 plus 2 router tests) |

The emulator test "rate-limit headers reach the app through the native bridge" read real headers from `api.github.com/rate_limit` (limit 60, remaining 48).

Build #31 of the same code stopped part-way through the self test at the Python timeout test and CI still reported success. Build #32 ran clean. The CI job now fails unless the self test ends with `fail=0`.

## Not tested

- OpenRouter, Groq and Gemini with real keys. Header names and formats are handled as those providers document them, and verified only against fake servers.
- A real Ollama server.
- Gemini's OpenAI-compatible model list does not appear to include context sizes, so Gemini models keep the default history budget.
- Whether a Groq or Gemini account has billing enabled cannot be seen by the app.

## Limits that remain

- Per-minute token limits are displayed when reported but requests are not yet sized against them.
- History is still trimmed by dropping old messages; summarising it is Phase 3.
