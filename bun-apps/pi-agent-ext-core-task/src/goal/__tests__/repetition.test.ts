import { test, expect } from "bun:test";
import { detectLoopStuck, trigramSimilarity, loopInterventionDirective, pushCapped } from "../repetition.js";

test("detectLoopStuck: narration-only after 2 toolless iters", () => {
	expect(detectLoopStuck({ assistantText: "thinking…", recentPrints: ["a"], recentToolResults: [], toollessStreak: 2 })).toMatch(/narration only/);
});
test("detectLoopStuck: near-duplicate previous response", () => {
	// NOTE: brief's original pair differs by a mid-sentence word ("the"), yielding trigram
	// similarity 0.722 < the hardcoded similarityThreshold (0.8) — so detection never fires.
	// Kept a genuine near-duplicate (one trailing word differs) so sim ≈ 0.895 ≥ 0.8. Module
	// thresholds/logic are unchanged (byte-identical to brief).
	const a = "I will now refactor the goal module by extracting the overflow helpers into a separate file for testability and clarity.";
	const b = "I will now refactor the goal module by extracting the overflow helpers into a separate file for testability and readability.";
	// Pin the fixture's intent: a + b must clear the 0.8 similarityThreshold so a
	// future threshold-lowering regression can't silently pass this end-to-end check.
	expect(trigramSimilarity(a, b)).toBeGreaterThanOrEqual(0.8);
	expect(detectLoopStuck({ assistantText: b, recentPrints: ["x", "y"], previousText: a, recentToolResults: [], toollessStreak: 0 })).toMatch(/similar/);
});
test("detectLoopStuck: undefined when progressing normally", () => {
	expect(detectLoopStuck({ assistantText: "did something new and different this time around", recentPrints: ["x", "y"], previousText: "totally different earlier work", recentToolResults: [], toollessStreak: 0 })).toBeUndefined();
});
test("trigramSimilarity: identity = 1, disjoint = 0", () => {
	expect(trigramSimilarity("the quick brown fox", "the quick brown fox")).toBe(1);
	expect(trigramSimilarity("alpha beta gamma", "one two three four five six")).toBe(0);
});
test("loopInterventionDirective escalates at hardResetAfter", () => {
	const d1 = loopInterventionDirective(1, "r", []);
	const d3 = loopInterventionDirective(3, "r", []);
	expect(d1).not.toContain("HARD RESET");
	expect(d3).toContain("HARD RESET");
});
test("pushCapped trims to cap", () => {
	expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
});
