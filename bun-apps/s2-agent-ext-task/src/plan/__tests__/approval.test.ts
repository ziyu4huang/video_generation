/**
 * approval.test.ts — the plan-approval state machine (cc-parity ticket 01).
 *
 * Pure unit tests over ../approval.ts: contract fingerprinting (progress
 * never invalidates, structure does), the needed/prompt predicates, and the
 * decision recording semantics (once-per-contract-version prompts).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { PlanPhaseInfo } from "../types.js";
import {
	__resetPlanApproval,
	isPlanApproved,
	planApprovalNeeded,
	phaseContract,
	planContract,
	recordPlanDecision,
	shouldPromptForApproval,
	summarizePhases,
} from "../approval.js";

function phase(overrides: Partial<PlanPhaseInfo> = {}): PlanPhaseInfo {
	return {
		id: "task-1",
		title: "Build it",
		status: "pending",
		stepCount: 3,
		completedSteps: 0,
		...overrides,
	};
}

describe("contract fingerprinting", () => {
	test("progress does not change the contract (checking boxes must not invalidate approval)", () => {
		const before = phase({ completedSteps: 0, status: "pending" });
		const after = phase({ completedSteps: 2, status: "in_progress" });
		expect(phaseContract(before)).toBe(phaseContract(after));
	});

	test("structural changes change the contract (stepCount / title / id)", () => {
		const base = phase();
		expect(phaseContract(phase({ stepCount: 4 }))).not.toBe(phaseContract(base));
		expect(phaseContract(phase({ title: "Other" }))).not.toBe(phaseContract(base));
		expect(phaseContract(phase({ id: "task-2" }))).not.toBe(phaseContract(base));
	});

	test("planContract is order-sensitive phase join", () => {
		const a = [phase({ id: "task-1" }), phase({ id: "task-2" })];
		const b = [phase({ id: "task-2" }), phase({ id: "task-1" })];
		expect(planContract(a)).not.toBe(planContract(b));
	});
});

describe("approval state machine", () => {
	const cwd = "/tmp/approval-test-cwd";
	const incomplete = [phase()];

	beforeEach(() => __resetPlanApproval());

	test("incomplete unapproved plan: needed + should prompt", () => {
		expect(planApprovalNeeded(cwd, incomplete)).toBe(true);
		expect(shouldPromptForApproval(cwd, incomplete)).toBe(true);
		expect(isPlanApproved(cwd, incomplete)).toBe(false);
	});

	test("approve: needed clears, no re-prompt for the same contract", () => {
		recordPlanDecision(cwd, incomplete, true);
		expect(isPlanApproved(cwd, incomplete)).toBe(true);
		expect(planApprovalNeeded(cwd, incomplete)).toBe(false);
		expect(shouldPromptForApproval(cwd, incomplete)).toBe(false);
	});

	test("deny: still needed, but no re-prompt per turn for the same contract", () => {
		recordPlanDecision(cwd, incomplete, false);
		expect(planApprovalNeeded(cwd, incomplete)).toBe(true); // still blocks
		expect(shouldPromptForApproval(cwd, incomplete)).toBe(false); // but silent
	});

	test("progress on a DENIED plan does not re-prompt (contract unchanged)", () => {
		recordPlanDecision(cwd, incomplete, false);
		const progressed = [phase({ completedSteps: 1, status: "in_progress" })];
		expect(planApprovalNeeded(cwd, progressed)).toBe(true);
		expect(shouldPromptForApproval(cwd, progressed)).toBe(false);
	});

	test("editing the plan's contract re-arms the prompt exactly once", () => {
		recordPlanDecision(cwd, incomplete, true);
		const edited = [phase({ stepCount: 5 })];
		expect(isPlanApproved(cwd, edited)).toBe(false); // approval did not follow the edit
		expect(shouldPromptForApproval(cwd, edited)).toBe(true); // re-prompt fires
		recordPlanDecision(cwd, edited, false); // denied once…
		expect(shouldPromptForApproval(cwd, edited)).toBe(false); // …not again per turn
	});

	test("complete plan needs no approval regardless of state", () => {
		const complete = [phase({ completedSteps: 3, status: "completed" })];
		expect(planApprovalNeeded(cwd, complete)).toBe(false);
		expect(shouldPromptForApproval(cwd, complete)).toBe(false);
	});

	test("empty plan needs no approval", () => {
		expect(planApprovalNeeded(cwd, [])).toBe(false);
	});

	test("state is per-cwd (worktree isolation)", () => {
		recordPlanDecision(cwd, incomplete, true);
		expect(isPlanApproved("/tmp/other-cwd", incomplete)).toBe(false);
	});
});

describe("summarizePhases (approval dialog render)", () => {
	test("renders marks, titles, and step progress", () => {
		const phases = [
			phase({ id: "task-1", title: "First", completedSteps: 3, status: "completed" }),
			phase({ id: "task-2", title: "Second", completedSteps: 1, status: "in_progress", stepCount: 4 }),
			phase({ id: "task-3", title: "Third", status: "pending", stepCount: 2, completedSteps: 0 }),
		];
		const summary = summarizePhases(phases);
		expect(summary).toContain("1/3 phases complete");
		expect(summary).toContain("1. [x] First (3/3 steps)");
		expect(summary).toContain("2. [~] Second (1/4 steps)");
		expect(summary).toContain("3. [ ] Third (0/2 steps)");
	});

	test("empty phases summarize to a bare header", () => {
		expect(summarizePhases([])).toBe("0/0 phases complete\n");
	});
});
