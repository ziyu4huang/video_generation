/**
 * Unit tests for the pure goal status-machine helpers extracted from goal.ts
 * into state.ts (Phase 1, Task 4). state.ts holds goal-owned types + the pure
 * status-machine functions; it must have ZERO @earendil-works/* imports
 * (only "crypto" + local ../format.js). These tests pin the pure behavior.
 */
import { test, describe, expect } from "bun:test";
import {
	createGoal,
	transitionGoal,
	normalizeGoalForBudget,
	incrementGoal,
	cloneGoal,
	isGoal,
	goalState,
	__resetGoalState,
	type ActiveGoal,
} from "../state.js";
import type { GoalListItem } from "../format.js";

test("createGoal seeds an active goal with the right shape", () => {
	const g = createGoal("do thing", 1000, 42);
	expect(g.id).toEqual(expect.any(String));
	expect(g.text).toBe("do thing");
	expect(g.status).toBe("active");
	expect(g.iteration).toBe(0);
	expect(g.tokensUsed).toBe(0);
	expect(g.baselineTokens).toBe(42);
	expect(g.tokenBudget).toBe(1000);
	expect(g.updatedAt).toBeGreaterThanOrEqual(g.startedAt);
});

test("normalizeGoalForBudget flips active → budget_limited at the cap", () => {
	const g = createGoal("x", 1000, 0);
	g.tokensUsed = 1000;
	expect(normalizeGoalForBudget({ ...g, status: "active" }).status).toBe("budget_limited");
});

test("normalizeGoalForBudget leaves below-budget active goals alone", () => {
	const g = createGoal("x", 1000, 0);
	g.tokensUsed = 999;
	expect(normalizeGoalForBudget({ ...g, status: "active" }).status).toBe("active");
});

test("normalizeGoalForBudget does not reactivate a budget_limited goal under budget", () => {
	const g = createGoal("x", 1000, 0);
	g.tokensUsed = 500;
	expect(normalizeGoalForBudget({ ...g, status: "budget_limited" }).status).toBe("budget_limited");
});

test("isGoal rejects malformed objects", () => {
	expect(isGoal(null)).toBe(false);
	expect(isGoal({ id: "x" })).toBe(false);
	expect(isGoal(createGoal("x", undefined, 0))).toBe(true);
});

test("isGoal accepts a fully-shaped goal and narrows it", () => {
	const g = createGoal("x", undefined, 0);
	const narrowed = (v: unknown): v is ActiveGoal => isGoal(v);
	expect(narrowed(g)).toBe(true);
});

test("transitionGoal preserves identity + bumps updatedAt", () => {
	const g = createGoal("x", undefined, 0);
	const paused = transitionGoal(g, "paused");
	expect(paused.status).toBe("paused");
	expect(paused.id).toBe(g.id);
	expect(paused.updatedAt).toBeGreaterThanOrEqual(g.updatedAt);
});

test("transitionGoal to active via budget_limited cap flips to budget_limited", () => {
	const g = createGoal("x", 100, 0);
	g.tokensUsed = 100;
	const next = transitionGoal({ ...g, status: "paused" }, "active");
	expect(next.status).toBe("budget_limited");
});

test("incrementGoal bumps iteration and updatedAt without touching tokens", () => {
	const g = createGoal("x", undefined, 0);
	const next = incrementGoal(g);
	expect(next.iteration).toBe(g.iteration + 1);
	expect(next.tokensUsed).toBe(g.tokensUsed);
	expect(next.updatedAt).toBeGreaterThanOrEqual(g.updatedAt);
	// Original is not mutated.
	expect(g.iteration).toBe(0);
});

test("cloneGoal returns a deep copy that is not reference-equal", () => {
	const g = createGoal("x", undefined, 0);
	const copy = cloneGoal(g);
	expect(copy).toEqual(g);
	expect(copy).not.toBe(g);
	copy.tokensUsed = 99;
	expect(g.tokensUsed).toBe(0);
});

test("__resetGoalState clears every runtime-state field back to its initial value", () => {
	// This reset is the liveness seam for the whole hardening feature: a missing
	// reset means cross-goal state leaks (the bug class behind the Task 9
	// false-positive). Mutate EVERY field off-baseline, then assert each one
	// returned to the value declared on the goalState singleton. A field whose
	// reset silently no-ops is caught here.
	const resetAt = Date.now();

	// Real interval handles so the timer field types match without a cast; kept
	// in locals so we can clearInterval them afterwards (__resetGoalState sets the
	// field to undefined and does NOT clear the underlying timer).
	const fakeStatusTimer = setInterval(() => {}, 1_000_000);
	const fakeHeartbeatTimer = setInterval(() => {}, 1_000_000);

	goalState.activeGoal = createGoal("mutated", 9, 7);
	goalState.extensionApi = { fake: "extensionApi" };
	goalState.continuationPending = { goalId: "g", iteration: 9, marker: "m", prompt: "p" };
	goalState.goalRecovery = { goalId: "g", kind: "provider_retry" };
	goalState.staleGoalToolCallsBlocked = true;
	goalState.statusRefreshTimer = fakeStatusTimer;
	goalState.latestCtx = { fake: "latestCtx" };
	goalState.cancelledContinuationMarkers.add("leaked-1");
	goalState.cancelledContinuationMarkers.add("leaked-2");
	goalState.consecutiveStuck = 9;
	goalState.stuckStartedAt = 12_345;
	goalState.recentPrints = ["print-1", "print-2"];
	goalState.recentTexts = ["text-1", "text-2"];
	goalState.recentToolResults = [{ tool: "bash", hash: "abc", isError: false }];
	goalState.toollessStreak = 9;
	goalState.toolRanThisTurn = true;
	goalState.heartbeatTimer = fakeHeartbeatTimer;
	goalState.lastActivityAt = 0;
	goalState.lastWedgeAlertAt = 99_999;
	goalState.nudgeCount = 9;
	// Loop 2 queue fields (Task 1): mutated so this watchdog proves __resetGoalState
	// resets them too — a silent no-op here would let a stale queue + inflated
	// position leak across a fresh goal cockpit (the bug class behind Loop 2).
	goalState.list = [{ id: "leaked", text: "x" }];
	goalState.headAdvances = 7;

	__resetGoalState();

	// Assert every field equals its declared initial value.
	expect(goalState.activeGoal).toBeUndefined();
	expect(goalState.extensionApi).toBeUndefined();
	expect(goalState.continuationPending).toBeUndefined();
	expect(goalState.goalRecovery).toBeUndefined();
	expect(goalState.staleGoalToolCallsBlocked).toBe(false);
	expect(goalState.statusRefreshTimer).toBeUndefined();
	expect(goalState.latestCtx).toBeUndefined();
	// cancelledContinuationMarkers: reset calls .clear() on the singleton (same
	// instance, not reassigned), so it must still be a Set, now empty.
	expect(goalState.cancelledContinuationMarkers).toBeInstanceOf(Set);
	expect(goalState.cancelledContinuationMarkers.size).toBe(0);
	expect(goalState.consecutiveStuck).toBe(0);
	expect(goalState.stuckStartedAt).toBeUndefined();
	expect(goalState.recentPrints).toEqual([]);
	expect(goalState.recentTexts).toEqual([]);
	expect(goalState.recentToolResults).toEqual([]);
	expect(goalState.toollessStreak).toBe(0);
	expect(goalState.toolRanThisTurn).toBe(false);
	expect(goalState.heartbeatTimer).toBeUndefined();
	// lastActivityAt is re-stamped to Date.now() on reset (was mutated to 0) —
	// assert it moved forward to a recent epoch ms, proving the assignment fired.
	expect(goalState.lastActivityAt).toBeGreaterThanOrEqual(resetAt);
	expect(goalState.lastWedgeAlertAt).toBe(0);
	expect(goalState.nudgeCount).toBe(0);
	expect(goalState.list).toEqual([]);
	expect(goalState.headAdvances).toBe(0);

	// Release the real timers we allocated (reset orphaned them on purpose).
	clearInterval(fakeStatusTimer);
	clearInterval(fakeHeartbeatTimer);
});

// ─── T04 opt-in auditor: createGoal pass-through (Task 2) ─────────────────────
// Absent audit options = current behavior: every audit field undefined, so a
// non-audited goal is indistinguishable from a pre-T04 goal. Present options
// land verbatim onto the goal (the auditor reads them later). auditHistory /
// auditAttempts are never seeded at creation — they accumulate during auditing.
describe("createGoal audit options", () => {
	test("defaults: audit disabled, no contract, undefined history/attempts", () => {
		const g = createGoal("ship feature X", undefined, 100);
		expect(g.auditEnabled).toBeUndefined();
		expect(g.verificationContract).toBeUndefined();
		expect(g.auditAttempts).toBeUndefined();
		expect(g.auditHistory).toBeUndefined();
	});
	test("audit options are passed through onto the goal", () => {
		const g = createGoal("ship feature X", undefined, 100, {
			auditEnabled: true,
			auditorModel: "anthropic/claude-sonnet-4",
			verificationContract: "tests green\nno regressions",
		});
		expect(g.auditEnabled).toBe(true);
		expect(g.auditorModel).toBe("anthropic/claude-sonnet-4");
		expect(g.verificationContract).toBe("tests green\nno regressions");
	});
});

// ─── Loop 2: GoalRuntimeState list fields (Task 1) ────────────────────────────
// goalState gains a `list` (the queue tail) + `headAdvances` (heads activated
// so far, drives the widget position). Both must reset on __resetGoalState so
// cross-session list state cannot leak into a fresh goal cockpit.
describe("GoalRuntimeState list fields", () => {
	test("list + headAdvances reset to initial by __resetGoalState", () => {
		goalState.list = [{ id: "x", text: "do thing" }];
		goalState.headAdvances = 7;
		__resetGoalState();
		expect(goalState.list).toEqual([]);
		expect(goalState.headAdvances).toBe(0);
	});
});

describe("GoalListItem shape", () => {
	test("a minimal item has id + text; optional fields default undefined", () => {
		const item: GoalListItem = { id: "a", text: "ship feature X" };
		expect(item.tokenBudget).toBeUndefined();
		expect(item.audit).toBeUndefined();
		expect(item.parked).toBeUndefined();
	});
});

// ─── Reviewer wiring: state fields (Task 3) ─────────────────────────────────────
describe("reviewer wiring — state", () => {
	test("createGoal defaults origin to 'bare'", () => {
		__resetGoalState();
		const g = createGoal("x", undefined, 0);
		expect(g.origin).toBe("bare");
	});
	test("createGoal accepts origin: 'list'", () => {
		const g = createGoal("y", undefined, 0, undefined, "list");
		expect(g.origin).toBe("list");
	});
	test("goalState.reviewerEnabled defaults true and resets on __resetGoalState", () => {
		__resetGoalState();
		expect(goalState.reviewerEnabled).toBe(true);
		goalState.reviewerEnabled = false;
		__resetGoalState();
		expect(goalState.reviewerEnabled).toBe(true);
	});
});
