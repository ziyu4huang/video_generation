# Tracer-bullet 2 — Publish `__piPlan*` seams (coordinator + wiring)

> Ticket [09](../tickets/09-build-coordination-layer.md) tracer-bullet 2 of ~6.
> Builds on [01-plan-parser](01-plan-parser.md). Publishes the 3 `__piPlan*` seams
> on globalThis so wayfind's existing readers (`chain.ts:58`, `coordination.ts:32/39`)
> light up. goal.ts self-consumption is tracer-bullet 3.

**Goal:** A coordinator parses + caches the active effort's plan per-cwd and serves `getPlanPhases`/`isPlanIncomplete`/`getPlanSummary`; `extensions/core-task.ts` publishes those as `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` (mirroring `__piGoalActive` L45), refreshed on `session_start` + `tool_execution_end`.

**Architecture:** `src/plan/coordinator.ts` = pure logic (`computeIncomplete`/`computeSummary`) + fs discovery + per-cwd cache. Discovery = the active effort (most-recently-modified `map.md` under `.planning/<effort>/`), aggregating phases from its `plans/*.md`; `docs/superpowers/plans/*.md` is a fallback only when no `.planning/<effort>/plans/` exists. Multi-plan precision / effort-selection refinement = ticket 05 (deferred).

**Tech Stack:** TypeScript, bun:test, node:fs. Package: `@repo/pi-agent-ext-core-task`.

## Global Constraints

- Pure logic (`computeIncomplete`/`computeSummary`) is unit-tested directly; fs discovery tested via temp dir.
- globalThis publish follows the `__piGoalActive` pattern (direct assignment; graceful no-op when peer absent).
- No skill edits (ADR-0004 / ticket 01 invariant holds).
- `( cd bun-apps/pi-agent-ext-core-task && bun test )`.

---

## Task 1: Pure logic — computeIncomplete / computeSummary (TDD)

**Files:** Create `src/plan/coordinator.ts` (pure fns first); Test `src/plan/__tests__/coordinator.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// src/plan/__tests__/coordinator.test.ts
import { describe, expect, it } from "bun:test";
import { computeIncomplete, computeSummary } from "../coordinator.ts";
import type { PlanPhaseInfo } from "../types.ts";

const ph = (over: Partial<PlanPhaseInfo>): PlanPhaseInfo =>
	({ id: "task-1", title: "t", status: "pending", stepCount: 1, completedSteps: 0, ...over });

describe("computeIncomplete", () => {
	it("false when no phases", () => expect(computeIncomplete([])).toBe(false));
	it("false when all completed", () =>
		expect(computeIncomplete([ph({ status: "completed", completedSteps: 1 })])).toBe(false));
	it("true when any non-completed", () =>
		expect(computeIncomplete([ph({ status: "completed" }), ph({ status: "in_progress" })])).toBe(true));
});

describe("computeSummary", () => {
	it("empty string when no phases", () => expect(computeSummary([], "/x.md")).toBe(""));
	it("done/total + sourcePath", () => {
		const s = computeSummary([ph({ id: "task-1", status: "completed" }), ph({ id: "task-2", status: "pending" })], "/x.md");
		expect(s).toBe("1/2 phases · /x.md");
	});
});
```

- [ ] **Step 2: Run → RED** (`coordinator.ts` missing).
- [ ] **Step 3: Implement pure fns in coordinator.ts**

```ts
import type { PlanPhaseInfo } from "./types.ts";

export function computeIncomplete(phases: PlanPhaseInfo[]): boolean {
	return phases.length > 0 && phases.some((p) => p.status !== "completed");
}

export function computeSummary(phases: PlanPhaseInfo[], sourcePath: string): string {
	if (phases.length === 0) return "";
	const done = phases.filter((p) => p.status === "completed").length;
	return `${done}/${phases.length} phases · ${sourcePath}`;
}
```

- [ ] **Step 4: Run → GREEN** (4 pass).
- [ ] **Step 5: Commit** `feat(core-task): plan coordinator pure logic (09 tracer-bullet 2)`.

---

## Task 2: Discovery + cache + read API

**Files:** Extend `src/plan/coordinator.ts` (fs discovery, per-cwd cache, `refreshPlan`/`getPlanPhases`/`isPlanIncomplete`/`getPlanSummary`/`__resetCoordinator`); extend test.

- [ ] **Step 1: Add fs-backed test via temp dir** — write a temp `.planning/<effort>/plans/x.md` + `map.md`, call `refreshPlan(tmp)`, assert `getPlanPhases` returns parsed phases + `isPlanIncomplete` true.
- [ ] **Step 2: Implement discovery** — `discoverActivePlan(cwd)`: find the effort dir under `.planning/` with the newest `map.md` (or any file), parse ALL its `plans/*.md`, aggregate phases; if none, scan `docs/superpowers/plans/*.md` newest-first. `refreshPlan(cwd)` caches the `ParsedPlan` (or null).
- [ ] **Step 3: Implement read API** — `getPlanPhases(cwd) = cache.get(cwd)?.phases ?? []`; `isPlanIncomplete`/`getPlanSummary` wrap `computeIncomplete`/`computeSummary` over the cached phases.
- [ ] **Step 4: Run → GREEN**.
- [ ] **Step 5: Commit** `feat(core-task): plan discovery + per-cwd cache (09 tracer-bullet 2)`.

---

## Task 3: Publish seams + hook wiring in core-task.ts

**Files:** Modify `extensions/core-task.ts`.

- [ ] **Step 1: Publish the 3 seams** (mirror `__piGoalActive` L45):

```ts
(globalThis as Record<string, unknown>).__piPlanPhases = (cwd: string) => getPlanPhases(cwd);
(globalThis as Record<string, unknown>).__piPlanIncomplete = (cwd: string) => isPlanIncomplete(cwd);
(globalThis as Record<string, unknown>).__piPlanSummary = (cwd: string) => getPlanSummary(cwd);
```

- [ ] **Step 2: Wire refresh hooks** — `session_start`: `refreshPlan(ctx.cwd)`; `tool_execution_end`: if the tool touched a `.planning/` or `docs/superpowers/plans/` path, `refreshPlan(ctx.cwd)`. (Yield to `__piGoalActive`/`__piWayfindGrill` is tracer-bullet 5.)
- [ ] **Step 3: Run full core-task suite → GREEN** (291 + new).
- [ ] **Step 4: Commit** `feat(core-task): publish __piPlan* seams + refresh hooks (09 tracer-bullet 2)`.

---

## Acceptance

- [ ] `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` published on globalThis from core-task.
- [ ] Active-effort discovery (newest `map.md`) aggregates that effort's `plans/*.md`; `docs/superpowers/plans/` fallback.
- [ ] core-task suite green; no skill edits.

## Next tracer-bullets

3-refactor-goal-readers (goal.ts → internal-call, drop self-read) · 4-drive-todo · 5-hooks-lifecycle (yield) · 6-e2e-wayfind.
