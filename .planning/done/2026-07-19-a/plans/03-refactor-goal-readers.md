---
tracer-bullet: 3
ticket: 09
status: done
depends on: [01, 02]
---

# 03 — Refactor goal.ts readers → internal-call coordinator

## Why (ticket 03)

Ticket 03 (closed) settled: **within-package self-consume = internal-call, NOT globalThis**. `core-task` publishes `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` on globalThis **only for wayfind** (cross-extension). `goal.ts` — which lives in the SAME package as the coordinator — must NOT self-publish-self-read; it calls the coordinator directly. This removes the fragile globalThis indirection from the in-package path.

## What changed

**`src/goal/goal.ts`** — two readers collapsed from globalThis-duck-typed reads to direct imports:

- `planningGateBlocking(cwd)` → `return isPlanIncomplete(cwd) ? "the plan still has incomplete phases" : undefined;`
- `planProgressLineFromPeer()` → `const cwd = latestCtx?.cwd; if (!cwd) return ""; return getPlanSummary(cwd);`
- Dropped the `typeof fn !== "function"` guards (the coordinator is always present — hard import) and the `try/catch` best-effort wrappers (the coordinator functions are **total**: cache reads + pure logic, never throw on a string cwd).
- `import { getPlanSummary, isPlanIncomplete } from "../plan/coordinator.js";`
- Function names **kept** (`planningGateBlocking` / `planProgressLineFromPeer`) — ticket 03's canonical names; JSDoc updated to the internal-call semantics.

**`src/goal/__tests__/goal.test.ts`** — 3 describe blocks rewired from globalThis mocks to **integration via temp-dir + `refreshPlan`** (a `makePlanTmp(planMd?)` helper writes `.planning/eff/{map.md,plans/01.md}` + refreshes; `cleanupPlanTmp` resets the coordinator cache + rm's the dir):

- `planningGateBlocking`: 4 → 3 tests (dropped the obsolete "peer throws → best-effort" case; the coordinator can't throw).
- `goal_complete planning gate`: 2 tests, now driving `ctx.cwd = tmp` + rewriting the plan file + `refreshPlan` to flip incomplete→complete mid-test (real goal↔coordinator path).
- `planProgressLineFromPeer + buildGoalSystemPrompt`: 3 → 2 tests (dropped throws; summary assertion moved from the old peer string `"Phase 1/3"` to the coordinator's format `0/1 phases`).

## Verification

- `bun test src/goal/__tests__/goal.test.ts`: **35 pass** (was 37; −2 obsolete throws tests; 7 coordination tests now integration-style).
- full `pi-agent-ext-core-task` suite: **297 pass**, 0 fail.
- `bun run typecheck`: **exit 0**.
- `grep __piPlan goal.ts`: zero reads (only descriptive comments remain).

## Behavior preserved

Observable contract unchanged: no-plan → undefined/`""`; open phases → reason string (blocks `goal_complete`); all-complete → undefined; summary surfaced in `buildGoalSystemPrompt` as the "Active plan progress:" roadmap bullet. The coordinator still publishes `__piPlan*` on globalThis for wayfind (unchanged).
