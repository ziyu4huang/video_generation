> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Subagent budget knobs (env vars + graceful wrap-up)

## Problem

The tier token-budget table (`TIERED_TOKEN_BUDGET_DEFAULTS` in `pi-agent-ext-subagent/src/budget-defaults.ts`) is hardcoded — there is no way to disable the default budget or rescale it (per tier or globally) without editing source. Worse, budget death is a hard abort: the child is killed mid-turn with `status:"budget"`, so the final report turn is eaten and the parent loses whatever the child had done.

## Decision

1. **Env-var knobs (part 1, this effort):** `tierDefaultToken()` reads env at call time —
   - `SUBAGENT_TOKEN_BUDGET_DISABLE=1|true` → no default budget;
   - `SUBAGENT_TOKEN_BUDGET_SMALL/_MEDIUM/_BIG` → absolute per-tier ceiling override;
   - `SUBAGENT_TOKEN_BUDGET_MULTIPLIER` → scale after any override; clamp to `max(1, floor(n))`.
   Invalid values are silently ignored. Return type widens to `number | undefined` (undefined = no budget; downstream already treats undefined as unbounded).
2. **Graceful wrap-up turn (part 2):** on budget crossing, instead of a bare hard abort the core-task loop injects a final-turn message — "token budget exhausted — write current state/artifacts to disk now, then stop" — allows one turn, then stops.

## Consumer story

A dispatcher that trusts a model tier (or wants a zero-cost experiment) can `SUBAGENT_TOKEN_BUDGET_DISABLE=1` one run without code changes; a flaky-model week can `_MULTIPLIER=2` globally; and when a budget does fire, the child still lands its artifacts + final report on disk instead of dying mid-sentence.
