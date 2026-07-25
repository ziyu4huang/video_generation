/**
 * Unit tests for the overflow / interruption-classification helpers extracted
 * from goal.ts into overflow.ts (Phase 1, Task 1).
 *
 * These are pure functions with ZERO @earendil-works/* dependencies, so they
 * are exercised directly here under plain Bun. The broader behavior
 * (goal_complete rejection, agent_end recovery, compaction) stays covered by
 * goal.test.ts, which imports the same symbols via the goal.ts re-export seam.
 */
import { test, expect, describe } from "bun:test";
import {
	isContextOverflow,
	isContradictoryCompletionSummary,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	findFinalAssistantMessage,
	type Usage,
} from "../overflow.js";

/** Build a full Usage fixture from the few fields isContextOverflow actually reads. */
function usageFixture(input: number, cacheRead: number): Usage {
	return {
		input, output: 0, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ─── isContextOverflow ───────────────────────────────────────────────────────

describe("isContextOverflow", () => {
	test("matches 'exceeds the context window'", () => {
		expect(isContextOverflow({ stopReason: "error", errorMessage: "prompt exceeds the context window" })).toBe(true);
	});

	test("matches 'prompt is too long'", () => {
		expect(isContextOverflow({ stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" })).toBe(true);
	});

	test("matches 'context_length_exceeded'", () => {
		expect(isContextOverflow({ stopReason: "error", errorMessage: "context_length_exceeded" })).toBe(true);
	});

	test("ignores pure rate-limit errors", () => {
		expect(isContextOverflow({ stopReason: "error", errorMessage: "too many requests (rate limit)" })).toBe(false);
	});

	test("ignores throttling errors", () => {
		expect(isContextOverflow({ stopReason: "error", errorMessage: "Throttling error: try again later" })).toBe(false);
	});

	test("returns false when stopReason is not error and no usage context", () => {
		expect(isContextOverflow({ stopReason: "stop" })).toBe(false);
	});

	test("returns false when there is no error message", () => {
		expect(isContextOverflow({ stopReason: "error" })).toBe(false);
	});

	test("flags stop with input tokens over contextWindow", () => {
		expect(
			isContextOverflow(
				{ stopReason: "stop", usage: usageFixture(9_000, 1_500) },
				10_000,
			),
		).toBe(true);
	});

	test("flags length stop at ~99% of context window with zero output", () => {
		expect(
			isContextOverflow(
				{ stopReason: "length", usage: usageFixture(9_900, 0) },
				10_000,
			),
		).toBe(true);
	});
});

// ─── isContradictoryCompletionSummary ────────────────────────────────────────

describe("isContradictoryCompletionSummary", () => {
	test("flags 'tests still failing'", () => {
		expect(isContradictoryCompletionSummary("the tests are still failing")).toBe(true);
	});

	test("flags 'not complete'", () => {
		expect(isContradictoryCompletionSummary("Not complete: tests still fail.")).toBe(true);
	});

	test("accepts verified summary", () => {
		expect(isContradictoryCompletionSummary("all requirements verified, tests green")).toBe(false);
		expect(isContradictoryCompletionSummary("Implemented and verified with npm test.")).toBe(false);
	});

	test("does not flag 'could not complete earlier, but now fixed'", () => {
		// The negative-lookbehind exemptes "could not complete" phrasing that is
		// followed by a recovery (kept to avoid false-positives on honest retros).
		expect(isContradictoryCompletionSummary("Could not complete earlier, but now fixed and verified.")).toBe(false);
	});
});

// ─── isRetryableGoalInterruption / isGoalContextOverflow ─────────────────────

describe("isRetryableGoalInterruption", () => {
	test("retryable on websocket closed", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000" }),
		).toBe(true);
	});

	test("retryable on overflow (provider error message)", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" }),
		).toBe(true);
	});

	test("non-retryable on usage limit", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." }),
		).toBe(false);
	});

	test("non-retryable when stopReason is not error", () => {
		expect(isRetryableGoalInterruption({ role: "assistant", stopReason: "stop" })).toBe(false);
	});

	test("non-retryable when there is no error message", () => {
		expect(isRetryableGoalInterruption({ role: "assistant", stopReason: "error" })).toBe(false);
	});
});

describe("isGoalContextOverflow", () => {
	test("delegates to isContextOverflow for the assistant message", () => {
		expect(
			isGoalContextOverflow({ role: "assistant", stopReason: "error", errorMessage: "prompt exceeds the context window" }),
		).toBe(true);
	});

	test("false for a clean stop", () => {
		expect(isGoalContextOverflow({ role: "assistant", stopReason: "stop" })).toBe(false);
	});
});

// ─── findFinalAssistantMessage ───────────────────────────────────────────────

describe("findFinalAssistantMessage", () => {
	test("returns the last assistant with a known stop reason", () => {
		expect(
			findFinalAssistantMessage([
				{ role: "assistant", stopReason: "stop" },
				{ role: "assistant", stopReason: "error", errorMessage: "bad" },
			]),
		).toEqual({
			role: "assistant",
			stopReason: "error",
			errorMessage: "bad",
		});
	});

	test("normalizes partial usage into a full Usage object", () => {
		const message = findFinalAssistantMessage([
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				usage: { input: 10, output: 2 },
			},
		]);

		expect(message?.usage?.input).toBe(10);
		expect(message?.usage?.output).toBe(2);
		expect(message?.usage?.cacheRead).toBe(0);
		expect(message?.usage?.totalTokens).toBe(12);
	});

	test("returns undefined when there are no assistant messages", () => {
		expect(findFinalAssistantMessage([{ role: "user", content: "hi" }])).toBeUndefined();
		expect(findFinalAssistantMessage([])).toBeUndefined();
	});
});
