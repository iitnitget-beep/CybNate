# Phase 2C: Auto mode (router + pipeline)

Branch: arena/702e73e1-cybnate. Tick a line when it is done and committed.

- [ ] 1. Router: rules first (Reverse / Chat / Planner / Coder), one small LLM call only when unclear, chip "Auto → X" with override
- [ ] 2. Pipeline: Planner → Coder → Reviewer → Coder fix (max 1 review round), Planner skipped for small tasks, reviewer from another model family, final run as proof
- [ ] 3. ask_agent (extends spawn_agent): planner, reverse, chat added; depth 1; max 3 asks per task; only Coder writes; Reverse writes only in analysis/
- [ ] 4. Model pool: role → model from a health-ranked list, with fallback chain
- [ ] 5. Global limiter: 2 concurrent per provider, RPM token bucket, daily counter, single-agent mode when budget is low
- [ ] 6. Task budget: 30 requests by default, "requests used: N/30", stop and report at the cap
- [ ] 7. Safety: sub-agents through the same approval gate, approvals one at a time, shell serial, sub-agent output in untrusted_data
- [ ] 8. UI: collapsible timeline with model and status per step
- [ ] 9. Tests: routing, budget cap, limiter, parallel approvals, fallback; emulator self test

## Notes
