import { describe, expect, it } from "bun:test";
import { parsePlan } from "../parse.ts";

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

describe("parsePlan — edge cases", () => {
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
});
