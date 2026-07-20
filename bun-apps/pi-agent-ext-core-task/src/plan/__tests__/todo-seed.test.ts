import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTodoFromPhases, seedTodoFromPlan } from "../todo-seed.js";
import { __resetCoordinator, refreshPlan } from "../coordinator.js";
import { __resetState, getTodos, replaceState } from "../../todo/state/store.js";
import type { PlanPhaseInfo } from "../types.js";

const ph = (over: Partial<PlanPhaseInfo>): PlanPhaseInfo =>
	({ id: "task-1", title: "t", status: "pending", stepCount: 1, completedSteps: 0, ...over });

describe("buildTodoFromPhases (pure)", () => {
	it("maps each phase to a Task with fresh ids + planPhaseId metadata", () => {
		const st = buildTodoFromPhases(
			[
				ph({ id: "task-1", title: "Parser", status: "completed", stepCount: 3, completedSteps: 3 }),
				ph({ id: "task-2", title: "Publish", status: "in_progress", stepCount: 2, completedSteps: 1, ticketIds: ["09"] }),
			],
			5,
		);
		expect(st.nextId).toBe(7);
		expect(st.tasks).toHaveLength(2);
		expect(st.tasks[0]).toMatchObject({ id: 5, subject: "Parser", status: "completed", metadata: { planPhaseId: "task-1" } });
		expect(st.tasks[0]?.description).toBe("3/3 steps");
		expect(st.tasks[1]).toMatchObject({ id: 6, subject: "Publish", status: "in_progress", metadata: { planPhaseId: "task-2" } });
		expect(st.tasks[1]?.description).toBe("1/2 steps · 09");
	});

	it("empty phases → empty tasks, nextId unchanged", () => {
		const st = buildTodoFromPhases([], 3);
		expect(st.tasks).toEqual([]);
		expect(st.nextId).toBe(3);
	});
});

describe("seedTodoFromPlan", () => {
	let tmp: string;

	beforeEach(() => {
		__resetState();
		__resetCoordinator();
		tmp = mkdtempSync(join(tmpdir(), "todo-seed-"));
		mkdirSync(join(tmp, ".planning", "eff", "plans"), { recursive: true });
		writeFileSync(join(tmp, ".planning", "eff", "map.md"), "# eff\n");
	});
	afterEach(() => {
		__resetState();
		__resetCoordinator();
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});

	it("seeds the todo from the plan when the todo is empty", () => {
		writeFileSync(join(tmp, ".planning", "eff", "plans", "01.md"), "# P\n### Task 1: Alpha\n- [ ] do it\n");
		refreshPlan(tmp);
		expect(seedTodoFromPlan(tmp)).toBe(true);
		expect(getTodos()).toHaveLength(1);
		expect(getTodos()[0]?.subject).toBe("Alpha");
		expect(getTodos()[0]?.status).toBe("pending");
		expect(getTodos()[0]?.metadata).toMatchObject({ planPhaseId: "task-1" });
	});

	it("no-op when the todo already has tasks (never clobbers in-session work)", () => {
		writeFileSync(join(tmp, ".planning", "eff", "plans", "01.md"), "# P\n### Task 1: Alpha\n- [ ] s\n");
		refreshPlan(tmp);
		replaceState({ tasks: [{ id: 1, subject: "existing", status: "in_progress" }], nextId: 2 });
		expect(seedTodoFromPlan(tmp)).toBe(false);
		expect(getTodos()).toHaveLength(1);
		expect(getTodos()[0]?.subject).toBe("existing");
	});

	it("no-op when no plan is cached", () => {
		refreshPlan(tmp); // empty effort → no plan
		expect(seedTodoFromPlan(tmp)).toBe(false);
		expect(getTodos()).toHaveLength(0);
	});
});
