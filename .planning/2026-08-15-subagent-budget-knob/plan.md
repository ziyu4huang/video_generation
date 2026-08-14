# Plan — subagent budget knobs

## Task 1 — env-var knobs for default token budgets (part 1) ✅ this dispatch

Scope: `bun-apps/pi-agent-ext-subagent`.

- `src/budget-defaults.ts` — `tierDefaultToken()` returns `number | undefined` and reads env AT CALL TIME (no module-level caching):
  1. `SUBAGENT_TOKEN_BUDGET_DISABLE` = "1"/"true" (case-insensitive) → `undefined` (no budget);
  2. base resolution unchanged (explicit tier → table; model→tier reverse-map; `SAFE_FALLBACK_TIER` = medium);
  3. `SUBAGENT_TOKEN_BUDGET_SMALL/_MEDIUM/_BIG` — positive integer string replaces the resolved tier's ceiling;
  4. `SUBAGENT_TOKEN_BUDGET_MULTIPLIER` — positive finite float multiplies the result (after any absolute override);
  5. clamp `Math.max(1, Math.floor(result))`; invalid/unparseable env values silently fall through to the previous step's value.
- Call sites (`src/subagent-tool-run.ts:310`, `src/subagents-tool.ts:201`, any other `tierDefaultToken` callers): `params.tokenBudget ?? tierDefaultToken(...)` now yields `number | undefined` — verify surrounding types accept undefined (downstream loop: `loop.tokenBudget !== undefined && ...` in `pi-agent-ext-core-task/src/loop/loop-state.ts`); widen minimally only if the compiler demands.
- Tests: `tests/budget-defaults.test.ts` — env save/restore per test; defaults, unknown-tier fallback, absolute override, multiplier, disable ("1"/"true"), invalid values ignored, multiplier-after-override.
- Docs: "Token budgets" section in the package README (tier defaults 500k/1.2M/1.5M p90-calibrated fuses; per-dispatch `tokenBudget`; the three env knobs + disable; explicit budgets normally reserved for deliberate spend caps — ref `.planning/knowledge/subagent-dispatch-budget-protocol.md`).
- Gate: `( cd bun-apps/pi-agent-ext-subagent && bun run test )` (biome + tsc build + bun test) must pass.

## Task 2 — core-task loop wrap-up turn on budget crossing (part 2, deferred)

On crossing `loop.tokenBudget` (`pi-agent-ext-core-task/src/loop/loop-state.ts`), instead of an immediate hard abort:

- inject a final-turn user/system message: "token budget exhausted — write current state/artifacts to disk now, then stop";
- allow exactly one more turn for the child to flush its report/artifacts;
- then stop the run (existing `status:"budget"` classification retained).

Detail (message plumbing, turn accounting, tests in `pi-agent-ext-core-task`) is deferred to the part-2 implementer.
