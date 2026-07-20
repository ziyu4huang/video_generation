# Tracer-bullet 1 — Plan parser (writing-plans → PlanPhaseInfo[])

> Ticket [09](../tickets/09-build-coordination-layer.md) tracer-bullet 1 of ~6.
> Foundation: a pure parser the publish/drive/e2e layers build on. Self-contained,
> fully unit-testable, no SDK. Subsequent tracer-bullets: 2-publish-seams,
> 3-refactor-goal-readers, 4-drive-todo, 5-hooks-lifecycle, 6-e2e-wayfind.
>
> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Parse a writing-plans-format plan file into `PlanPhaseInfo[]` (Task ≡ phase), so the coordination layer can drive `/goal`+`todo` and publish `__piPlanPhases` for wayfind.

**Architecture:** Pure function `parsePlan(markdown, sourcePath) → ParsedPlan`. No fs, no SDK, no globalThis — fully unit-testable. Lives in `pi-agent-ext-core-task/src/plan/`. The publish layer (tracer-bullet 2) calls it; goal.ts readers (tracer-bullet 3) consume its output via internal-call.

**Tech Stack:** TypeScript, bun:test, typebox. Package: `@repo/pi-agent-ext-core-task`.

## Global Constraints

- Artifacts English; conversation zh-TW.
- `pi-agent-ext-core-task` is the coordination-layer home (ticket 02).
- Task ≡ phase; `PlanPhaseInfo.id` = writing-plans Task number; `ticketIds` = `[NN-slug]` refs from Task headers (ticket 03).
- Pure function only this tracer-bullet — NO globalThis, NO fs reads, NO SDK imports in `parse.ts`.
- Run tests: `( cd bun-apps/pi-agent-ext-core-task && bun test )`.

## Grammar (the contract)

Writing-plans format (from `superpowers/writing-plans` SKILL.md + ticket 03):

```
# <Feature> Implementation Plan
> For agentic workers: ...
**Goal:** ...
### Task N: <Title>            ← or "### Task N — [NN-slug] <Title>"
**Files:** ...
- [ ] **Step 1: ...**          ← pending step
- [x] **Step 2: ...**          ← completed step
### Task N+1: ...
```

`PlanPhaseInfo`:
- `id`: `"task-<N>"` (N = the Task number from the header).
- `title`: the header text after `Task N:`/`Task N —`.
- `ticketIds?`: all `[NN-slug]` bracketed refs in the header line (regex `\[(\d{2}-[a-z0-9-]+)\]`), e.g. `### Task 3 — [04-sync-timing] [05-multi-plan]` → `["04-sync-timing","05-multi-plan"]`. `undefined` when none.
- `status`: `"completed"` if `stepCount>0 && completedSteps===stepCount`; `"in_progress"` if `0 < completedSteps < stepCount`; `"pending"` if `completedSteps===0`. A Task with zero steps → `"pending"` (no steps to complete).
- `stepCount`, `completedSteps`: counts of `- [ ]`/`- [x]` step lines in the Task block.

`ParsedPlan`: `{ phases: PlanPhaseInfo[]; sourcePath: string }`.

---

## Task 1: Types + parser skeleton (RED)

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/plan/types.ts`
- Create: `bun-apps/pi-agent-ext-core-task/src/plan/parse.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/plan/__tests__/parse.test.ts`

**Interfaces:**
- Produces: `parsePlan(md: string, sourcePath: string): ParsedPlan`; `PlanPhaseInfo`; `ParsedPlan`.

- [ ] **Step 1: Write the failing tests (types + minimal parse)**

```ts
// src/plan/__tests__/parse.test.ts
import { describe, expect, it } from "bun:test";
import { parsePlan } from "../parse.ts";
import type { PlanPhaseInfo } from "../types.ts";

const ONE_TASK_ALL_DONE = `# Foo Implementation Plan
**Goal:** x
### Task 1: Do the thing
- [x] **Step 1: a**
- [x] **Step 2: b**
`;

const ONE_TASK_MIXED = `# Foo Implementation Plan
### Task 7 — [04-sync-timing] Sync
- [ ] **Step 1: a**
- [x] **Step 2: b**
`;

const NO_TASKS = `# Foo Implementation Plan
**Goal:** no tasks yet
`;

describe("parsePlan", () => {
	it("returns empty phases when no Task headers", () => {
		const p = parsePlan(NO_TASKS, "/x/plan.md");
		expect(p.phases).toEqual([]);
		expect(p.sourcePath).toBe("/x/plan.md");
	});

	it("Task ≡ phase: one Task → one phase, id from Task number", () => {
		const p = parsePlan(ONE_TASK_ALL_DONE, "/x.md");
		expect(p.phases).toHaveLength(1);
		expect(p.phases[0].id).toBe("task-1");
		expect(p.phases[0].title).toBe("Do the thing");
	});

	it("all steps done → completed", () => {
		const p = parsePlan(ONE_TASK_ALL_DONE, "/x.md");
		expect(p.phases[0].status).toBe("completed");
		expect(p.phases[0].stepCount).toBe(2);
		expect(p.phases[0].completedSteps).toBe(2);
	});

	it("mixed steps → in_progress; extracts [NN-slug] ticketIds", () => {
		const p = parsePlan(ONE_TASK_MIXED, "/x.md");
		expect(p.phases[0].id).toBe("task-7");
		expect(p.phases[0].status).toBe("in_progress");
		expect(p.phases[0].ticketIds).toEqual(["04-sync-timing"]);
	});

	it("ticketIds undefined when header has none", () => {
		const p = parsePlan(ONE_TASK_ALL_DONE, "/x.md");
		expect(p.phases[0].ticketIds).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run — expect RED (parsePlan / types not defined)**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test src/plan/__tests__/parse.test.ts )
```
Expected: FAIL — `Cannot find module '../parse.ts'`.

- [ ] **Step 3: Write types.ts**

```ts
// src/plan/types.ts
export type PlanPhaseStatus = "pending" | "in_progress" | "completed";

export interface PlanPhaseInfo {
	id: string; // "task-<N>"
	title: string;
	status: PlanPhaseStatus;
	ticketIds?: string[]; // [NN-slug] refs from the Task header
	stepCount: number;
	completedSteps: number;
}

export interface ParsedPlan {
	phases: PlanPhaseInfo[];
	sourcePath: string;
}
```

- [ ] **Step 4: Write parse.ts (minimal to pass)**

```ts
// src/plan/parse.ts
import type { ParsedPlan, PlanPhaseInfo, PlanPhaseStatus } from "./types.ts";

const TASK_HEADER_RE = /^###\s+Task\s+(\d+)\s*[:—-]?\s*(.*)$/;
const TICKET_RE = /\[(\d{2}-[a-z0-9-]+)\]/g;
const STEP_RE = /^-\s+\[(x| )\]\s+/i;

export function parsePlan(markdown: string, sourcePath: string): ParsedPlan {
	const lines = markdown.split(/\r?\n/);
	const phases: PlanPhaseInfo[] = [];
	let cur: (PlanPhaseInfo & { _steps: number; _done: number }) | null = null;

	const flush = () => {
		if (!cur) return;
		const stepCount = cur._steps;
		const completedSteps = cur._done;
		const status: PlanPhaseStatus =
			stepCount > 0 && completedSteps === stepCount
				? "completed"
				: completedSteps > 0
					? "in_progress"
					: "pending";
		const { _steps, _done, ...rest } = cur;
		phases.push({ ...rest, stepCount, completedSteps, status });
		cur = null;
	};

	for (const line of lines) {
		const h = TASK_HEADER_RE.exec(line);
		if (h) {
			flush();
			const id = `task-${h[1]}`;
			const title = (h[2] ?? "").trim();
			const ticketIds = [...title.matchAll(TICKET_RE)].map((m) => m[1]);
			cur = {
				id,
				title: title.replace(TICKET_RE, "").trim(),
				status: "pending",
				ticketIds: ticketIds.length > 0 ? ticketIds : undefined,
				_steps: 0,
				_done: 0,
			};
			continue;
		}
		if (!cur) continue; // skip header/preamble before first Task
		const s = STEP_RE.exec(line);
		if (s) {
			cur._steps += 1;
			if (s[1].toLowerCase() === "x") cur._done += 1;
		}
	}
	flush();
	return { phases, sourcePath };
}
```

- [ ] **Step 5: Run — expect GREEN**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test src/plan/__tests__/parse.test.ts )
```
Expected: 5 pass.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/plan/
git commit -m "feat(core-task): plan parser — writing-plans → PlanPhaseInfo[] (09 tracer-bullet 1)"
```

---

## Task 2: Edge cases (harden the grammar)

**Files:**
- Modify: `src/plan/__tests__/parse.test.ts` (add cases)
- Modify: `src/plan/parse.ts` (only if a case fails)

- [ ] **Step 1: Add edge-case tests**

```ts
const TWO_TASKS = `# P
### Task 1: A
- [x] **Step 1: a**
### Task 2: B
- [ ] **Step 1: b**
- [x] **Step 2: c**
`;
const ZERO_STEP_TASK = `# P
### Task 3: C
**Files:** ...
`;
const MULTI_TICKET = `# P
### Task 1 — [04-sync] [05-multi] Do
- [ ] s
`;

it("multiple Tasks → ordered phases", () => {
	const p = parsePlan(TWO_TASKS, "/x.md");
	expect(p.phases.map((ph) => ph.id)).toEqual(["task-1", "task-2"]);
	expect(p.phases[1].status).toBe("in_progress");
});

it("Task with zero steps → pending, stepCount 0", () => {
	const p = parsePlan(ZERO_STEP_TASK, "/x.md");
	expect(p.phases[0].status).toBe("pending");
	expect(p.phases[0].stepCount).toBe(0);
});

it("multiple [NN-slug] in one header", () => {
	const p = parsePlan(MULTI_TICKET, "/x.md");
	expect(p.phases[0].ticketIds).toEqual(["04-sync", "05-multi"]);
});

it("is pure — no mutation of input, repeatable", () => {
	const md = TWO_TASKS;
	parsePlan(md, "/x.md");
	parsePlan(md, "/x.md");
	expect(parsePlan(md, "/x.md").phases).toHaveLength(2);
});
```

- [ ] **Step 2: Run — fix parse.ts only if a case fails**

```bash
( cd bun-apps/pi-agent-ext-core-task && bun test src/plan/__tests__/parse.test.ts )
```
Expected: all pass (the Task-1 impl already handles these). If a header form like `### Task 1—Title` (no space) fails, relax `TASK_HEADER_RE`.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/plan/__tests__/parse.test.ts
git commit -m "test(core-task): plan parser edge cases (09 tracer-bullet 1)"
```

---

## Acceptance for this tracer-bullet

- [ ] `parsePlan(md, path)` is PURE (no fs/SDK/globalThis) — verifiable: the test imports only `parse.ts` + `types.ts`, no side effects.
- [ ] All edge cases pass; full `pi-agent-ext-core-task` suite stays green (`bun test` → +9 tests, 0 fail).
- [ ] `PlanPhaseInfo` shape matches ticket 03's contract (`id`, `status`, `ticketIds?`) — the shape wayfind `chain.ts:58` consumes via `__piPlanPhases`.

## Next tracer-bullets (sequence, not in this plan)

2. **publish-seams** — `src/plan/coordinator.ts`: hold parsed plan per-cwd; publish `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` on globalThis from `extensions/core-task.ts` (mirror `__piGoalActive` L45). Decides ticket-04 (where the plan file lives + when to parse: `session_start` + `tool_execution_end` after a plan write).
3. **refactor-goal-readers** — `goal.ts` `planningGateBlocking` (L984) / `planProgressLineFromPeer` (L1004) → internal-call the coordinator; drop globalThis self-read.
4. **drive-todo** — seed `todo` list from plan Tasks/Steps via `store.ts` (`replaceState`/`commitState`); structure = plan-master.
5. **hooks-lifecycle** — wire parse + publish + todo-seed in `extensions/core-task.ts` hooks; yield to `__piGoalActive`/`__piWayfindGrill`.
6. **e2e-wayfind** — verify `chain.ts:58 syncChainState` closes `[NN-slug]` tickets for completed phases; acceptance from ticket 09.
