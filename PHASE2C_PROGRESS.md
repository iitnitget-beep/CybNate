# Phase 2C: Auto mode (router + pipeline)

Branch: arena/702e73e1-cybnate. Tick a line when it is done and committed.

- [x] 1. Router: rules first (Reverse / Chat / Planner / Coder), one small LLM call only when unclear, chip "Auto → X" with override
- [x] 2. Pipeline: Planner → Coder → Reviewer → Coder fix (max 1 review round), Planner skipped for small tasks, reviewer from another model family, final run as proof
- [x] 3. ask_agent (extends spawn_agent): planner, reverse, chat added; depth 1; max 3 asks per task; only Coder writes; Reverse writes only in analysis/
- [x] 4. Model pool: role → model from a health-ranked list, with fallback chain
- [x] 5. Global limiter: 2 concurrent per provider, RPM token bucket, daily counter, single-agent mode when budget is low
- [x] 6. Task budget: 30 requests by default, "requests used: N/30", stop and report at the cap
- [x] 7. Safety: sub-agents through the same approval gate, approvals one at a time, shell serial, sub-agent output in untrusted_data
- [x] 8. UI: collapsible timeline with model and status per step
- [x] 9a. Tests: tests/orchestra.test.js and tests/auto.test.js (routing, budget cap, limiter, parallel approvals, fallback) pass locally
- [x] 9b. Emulator self test on the new build: pass=30 fail=0 (27 earlier + 3 Auto mode tests; the UI run went through Auto → Coder)

## Notes
