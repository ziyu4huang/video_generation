import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__resetCoordinator,
	computeIncomplete,
	computeSummary,
	discoverActivePlan,
	getPlanPhases,
	getPlanSummary,
	isPlanIncomplete,
	refreshPlan,
	shouldRefreshAfterTool,
} from "../coordinator.ts";
import type { PlanPhaseInfo } from "../types.ts";

const ph = (over: Partial<PlanPhaseInfo>): PlanPhaseInfo =>
	({ id: "task-1", title: "t", status: "pending", stepCount: 1, completedSteps: 0, ...over });

describe("computeIncomplete (pure)", () => {
	it("false when no phases", () => expect(computeIncomplete([])).toBe(false));
	it("false when all completed", () =>
		expect(computeIncomplete([ph({ status: "completed", completedSteps: 1 })])).toBe(false));
	it("true when any non-completed", () =>
		expect(computeIncomplete([ph({ status: "completed" }), ph({ status: "in_progress" })])).toBe(true));
});

describe("computeSummary (pure)", () => {
	it("empty string when no phases", () => expect(computeSummary([], "/x.md")).toBe(""));
	it("done/total + sourcePath", () => {
		const s = computeSummary(
			[ph({ id: "task-1", status: "completed" }), ph({ id: "task-2", status: "pending" })],
			"/x.md",
		);
		expect(s).toBe("1/2 phases · /x.md");
	});
});

describe("discoverActivePlan (fs)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "plan-coord-"));
		__resetCoordinator();
	});
	afterEach(() => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});

	it("aggregates phases from the active effort's plans/", () => {
		mkdirSync(join(tmp, ".planning", "eff", "plans"), { recursive: true });
		writeFileSync(join(tmp, ".planning", "eff", "map.md"), "# eff\n");
		writeFileSync(
			join(tmp, ".planning", "eff", "plans", "01-x.md"),
			"# P\n### Task 1: A\n- [ ] s\n### Task 2: B\n- [x] s\n",
		);
		refreshPlan(tmp);
		expect(getPlanPhases(tmp)).toHaveLength(2);
		expect(isPlanIncomplete(tmp)).toBe(true); // task-1 still pending
		expect(getPlanSummary(tmp)).toContain("1/2 phases");
	});

	it("no plan → empty phases, not incomplete, empty summary", () => {
		refreshPlan(tmp);
		expect(getPlanPhases(tmp)).toEqual([]);
		expect(isPlanIncomplete(tmp)).toBe(false);
		expect(getPlanSummary(tmp)).toBe("");
	});

	// Failure memory #278: an active effort (map.md) with NO plans/ dir must NOT
	// fall back to the global docs/superpowers/plans/ (≈ .planning/plans/) or any
	// other cross-effort plan — that returns an unrelated stale plan and causes a
	// goal_complete false-positive. Must surface "no active plan" instead.
	it("active effort with no plans/ must not pick up docs/superpowers/plans/ (#278)", () => {
		// Active effort exists (newest map.md) but has no plans/ subdir.
		mkdirSync(join(tmp, ".planning", "lonely-effort"), { recursive: true });
		writeFileSync(join(tmp, ".planning", "lonely-effort", "map.md"), "# lonely\n");
		// Unrelated stale plan sitting in the global fallback dir.
		mkdirSync(join(tmp, "docs", "superpowers", "plans"), { recursive: true });
		writeFileSync(
			join(tmp, "docs", "superpowers", "plans", "stale.md"),
			"# Stale\n### Task 1: Old thing\n- [x] done\n",
		);

		// Direct: discoverActivePlan must NOT return the stale global plan.
		expect(discoverActivePlan(tmp)).toBeUndefined();
		// Pipeline: the cached readers must report "no active plan".
		refreshPlan(tmp);
		expect(getPlanPhases(tmp)).toEqual([]);
		expect(isPlanIncomplete(tmp)).toBe(false);
		expect(getPlanSummary(tmp)).toBe("");
	});

	it("active effort with empty plans/ must not fall back to docs/superpowers/plans/ (#278)", () => {
		// Active effort: map.md present, plans/ dir exists but holds no .md.
		mkdirSync(join(tmp, ".planning", "eff", "plans"), { recursive: true });
		writeFileSync(join(tmp, ".planning", "eff", "map.md"), "# eff\n");
		// Unrelated stale plan sitting in the global fallback dir.
		mkdirSync(join(tmp, "docs", "superpowers", "plans"), { recursive: true });
		writeFileSync(
			join(tmp, "docs", "superpowers", "plans", "stale.md"),
			"# Stale\n### Task 1: Old thing\n- [x] done\n",
		);

		expect(discoverActivePlan(tmp)).toBeUndefined();
		refreshPlan(tmp);
		expect(getPlanPhases(tmp)).toEqual([]);
		expect(isPlanIncomplete(tmp)).toBe(false);
		expect(getPlanSummary(tmp)).toBe("");
	});
});

describe("shouldRefreshAfterTool (TB5a refresh gating)", () => {
	it("true for file-mutating tools (write/edit/bash)", () => {
		for (const t of ["write", "edit", "bash"]) expect(shouldRefreshAfterTool(t), `${t} should refresh`).toBe(true);
	});

	it("false for read-only / non-plan tools", () => {
		for (const t of ["read", "grep", "ls", "find", "todo", "memory", "web_search"])
			expect(shouldRefreshAfterTool(t), `${t} should not refresh`).toBe(false);
	});
});
