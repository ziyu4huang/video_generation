/**
 * Unit tests for the prompt-builder helpers extracted from goal.ts into
 * prompts.ts (Phase 1, Task 3).
 *
 * prompts.ts is a PURE module — the plan-progress line that used to be read
 * from module state (planProgressLineFromPeer, which reads latestCtx) is now
 * INJECTED as an argument into buildGoalSystemPrompt + buildContinuePrompt.
 * That is the key wrinkle exercised here: the builders no longer touch module
 * state, so they are tested directly under plain Bun with no pi/ctx setup.
 *
 * Broader behavior (lifecycle wiring, call-site injection of
 * planProgressLineFromPeer()) stays covered by goal.test.ts, which imports
 * buildGoalSystemPrompt via the goal.ts re-export seam.
 */
import { test, expect, describe } from "bun:test";
import {
	buildGoalSystemPrompt,
	buildContinuePrompt,
	buildGoalPrompt,
	buildObjectiveUpdatedPrompt,
	buildResumePrompt,
	goalObjectiveBlock,
	goalPersistenceRules,
	goalCommandHint,
	goalSummary,
	escapeXmlText,
	continuationMarkerComment,
	THREE_LAYER_GUIDANCE,
} from "../prompts.js";
import type { ActiveGoal, GoalStatus } from "../format.js";

const goal: ActiveGoal = {
	id: "g1",
	text: "ship <it>",
	status: "active",
	startedAt: 0,
	updatedAt: 0,
	iteration: 0,
	tokenBudget: 1000,
	tokensUsed: 0,
	timeUsedSeconds: 0,
	baselineTokens: 0,
};

const goalNoBudget: ActiveGoal = { ...goal, tokenBudget: undefined };

// ─── buildGoalSystemPrompt ───────────────────────────────────────────────────

describe("buildGoalSystemPrompt", () => {
	test("escapes XML in the objective", () => {
		const p = buildGoalSystemPrompt(goal, "");
		expect(p).toContain("<goal_objective>");
		expect(p).toContain("ship &lt;it&gt;"); // escaped, not raw <
		expect(p).not.toContain("ship <it>");
	});

	test("includes plan progress when provided", () => {
		expect(buildGoalSystemPrompt(goal, "2/5 phases · x")).toContain("2/5 phases");
	});

	test("omits the plan-progress bullet when the line is empty", () => {
		expect(buildGoalSystemPrompt(goal, "")).not.toContain("Active plan progress");
	});

	test("includes budget rule when the goal carries a budget", () => {
		expect(buildGoalSystemPrompt(goal, "")).toMatch(/Respect the goal token budget/);
	});

	test("includes three-layer fusion guidance", () => {
		expect(buildGoalSystemPrompt(goal, "")).toContain(THREE_LAYER_GUIDANCE);
	});
});

// ─── buildContinuePrompt ─────────────────────────────────────────────────────

describe("buildContinuePrompt", () => {
	test("embeds the continuation marker", () => {
		expect(buildContinuePrompt(goal, "m1", "")).toContain("pi-goal-continuation:m1");
	});

	test("includes plan progress when provided", () => {
		expect(buildContinuePrompt(goal, "m1", "3/4 phases")).toContain("3/4 phases");
	});

	test("omits plan-progress note when the line is empty", () => {
		expect(buildContinuePrompt(goal, "m1", "")).not.toContain("Continue the next open phase");
	});

	test("escapes XML in the objective", () => {
		expect(buildContinuePrompt(goal, "m1", "")).toContain("ship &lt;it&gt;");
	});
});

// ─── builder smoke (no plan-line param) ─────────────────────────────────────

describe("buildGoalPrompt / buildObjectiveUpdatedPrompt / buildResumePrompt", () => {
	test("buildGoalPrompt embeds objective + persistence rules", () => {
		const p = buildGoalPrompt(goalNoBudget);
		expect(p).toContain("<goal_objective>");
		expect(p).toContain(goalPersistenceRules("this goal"));
	});

	test("buildGoalPrompt adds a budget line when budgeted", () => {
		expect(buildGoalPrompt(goal)).toMatch(/Token budget:/);
	});

	test("buildObjectiveUpdatedPrompt embeds budget + persistence", () => {
		const p = buildObjectiveUpdatedPrompt(goal);
		expect(p).toMatch(/Token budget:.*used/);
		expect(p).toContain(goalPersistenceRules("the updated goal"));
	});

	test("buildResumePrompt embeds budget + persistence", () => {
		const p = buildResumePrompt(goal);
		expect(p).toMatch(/Token budget:.*used/);
		expect(p).toContain(goalPersistenceRules("this goal"));
	});
});

// ─── goalObjectiveBlock / escapeXmlText ─────────────────────────────────────

describe("goalObjectiveBlock", () => {
	test("wraps the escaped objective in <goal_objective>", () => {
		expect(goalObjectiveBlock(goal)).toBe("<goal_objective>\nship &lt;it&gt;\n</goal_objective>");
	});
});

describe("escapeXmlText", () => {
	test("escapes & < >", () => {
		expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});
	test("leaves other characters untouched", () => {
		expect(escapeXmlText("plain text 123 \"quote\" 'apos'")).toBe("plain text 123 \"quote\" 'apos'");
	});
});

// ─── continuationMarkerComment ──────────────────────────────────────────────

describe("continuationMarkerComment", () => {
	test("wraps the marker in an HTML comment with the prefix", () => {
		expect(continuationMarkerComment("xyz")).toBe("<!-- pi-goal-continuation:xyz -->");
	});
});

// ─── goalCommandHint ────────────────────────────────────────────────────────

describe("goalCommandHint", () => {
	const cases: Array<[GoalStatus, RegExp]> = [
		["active", /pause/],
		["paused", /resume/],
		["budget_limited", /clear/],
		["complete", /clear/],
	];
	for (const [status, re] of cases) {
		test(`hint for ${status} matches ${re}`, () => {
			expect(goalCommandHint(status)).toMatch(re);
		});
	}
});

// ─── goalSummary ────────────────────────────────────────────────────────────

describe("goalSummary", () => {
	test("includes the objective, status, iteration, elapsed, tokens, commands", () => {
		const s = goalSummary(goal);
		expect(s).toContain(`Goal: ${goal.text}`);
		expect(s).toContain(`Status: ${goal.status}`);
		expect(s).toContain(`Iteration: ${goal.iteration}`);
		expect(s).toMatch(/Elapsed:/);
		expect(s).toMatch(/Tokens:/);
		expect(s).toMatch(/Commands:/);
	});

	test("includes the last review cascade step when present", () => {
		const s = goalSummary(goal, {
			cascadeStep: "convert-findings-to-list",
			enqueued: 2,
			proposed: 1,
		});
		expect(s).toContain("review:");
		expect(s).toContain("convert-findings-to-list");
		expect(s).toContain("2 enqueued");
		expect(s).toContain("1 proposed");
	});

	test("excludes review line when lastReview is absent", () => {
		const s = goalSummary(goal);
		expect(s).not.toContain("review:");
	});
});
