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

## Task 2 — budget wrap-up turn on crossing (part 2) ✅ implemented

> **Re-port note (post-merge)**: the merge of origin/main (e5e5f9ed) silently dropped this wrap-up — it was re-ported atop #1329's `createBudgetGuard` (onUsage-seam mid-turn `check` + turn-boundary backstop): the grace now gates BOTH abort paths, and if the session surface cannot queue a followUp (or the queue call rejects) the guard falls back to #1329's immediate hard abort.

**Seam correction**: the budget is enforced in `bun-apps/pi-agent-ext-core-runtime/src/agent.ts` (`checkBudgetExhaustion` + the session-subscribe seam in `CoreAgent.run`) — NOT in `pi-agent-ext-core-task`'s loop. The loop package's budget check (`src/loop/loop-state.ts`) is the `/loop` slash-command path, not the subagent-dispatch path, so implementing there would not have affected subagents at all.

Implemented (core-runtime `agent.ts`):
- `createBudgetGuard(session, {tokenBudget, spendBudget})` — extracted, unit-testable two-stage stop wired into the existing subscribe seam:
  - first `tokenBudget` crossing → per-run `budgetWrapUpIssued` flag set + ONE `BUDGET_WRAP_UP_MESSAGE` user message queued via `session.sendUserMessage(..., {deliverAs:"followUp"})` so it lands on the model's next (final) turn; no abort;
  - second crossing → existing behavior bit-for-bit (`session.abort()` → `BudgetExhausted` → `status:"budget"`);
  - `spendBudget` stays a hard abort (money valve, no wrap-up); both crossing at once → hard abort wins; `sendUserMessage` failure → fallback hard abort.
- Tests: `tests/budget-guard.test.ts` (fake-session harness: first crossing injects + no abort; second crossing aborts; no budget → nothing; spend-only → immediate abort; both → hard abort; rejection fallback).
- Docs: `pi-agent-ext-subagent/README.md` "Token budgets" — wrap-up paragraph + spendBudget hard-stop note.
- Gate: `( cd bun-apps/pi-agent-ext-core-runtime && bun run test && bunx tsc --noEmit )` — 143 pass. Downstream `( cd bun-apps/pi-agent-ext-subagent && bun run test )` — 518 pass.
- Implemented in commit: d79a0416
