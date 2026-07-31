import { describe, expect, it } from "bun:test";
import {
	DEFAULT_REVIEWER_CONFIG,
	resolveReviewerConfig,
	classifyFindingText,
	stripCodeSpans,
	unwrapHardWrappedLines,
	cutAtClauseBoundary,
	normalizeObjective,
} from "../reviewer.js";

describe("reviewer — config", () => {
	it("default mode is on, leverage fix-without-confirm, caps set", () => {
		expect(DEFAULT_REVIEWER_CONFIG.mode).toBe("on");
		expect(DEFAULT_REVIEWER_CONFIG.leverageMode).toBe("fix-without-confirm");
		expect(DEFAULT_REVIEWER_CONFIG.maxFindingsPerReview).toBe(10);
		expect(DEFAULT_REVIEWER_CONFIG.maxReviewsPerDay).toBe(20);
		expect(DEFAULT_REVIEWER_CONFIG.fireOn).toContain("goal-complete");
	});
	it("merges a partial block over defaults", () => {
		const c = resolveReviewerConfig({ maxFindingsPerReview: 3 });
		expect(c.maxFindingsPerReview).toBe(3);
		expect(c.mode).toBe("on"); // untouched
	});
	it("migrates legacy 'default'/'report' modes to 'on'", () => {
		expect(resolveReviewerConfig({ mode: "default" as never }).mode).toBe("on");
		expect(resolveReviewerConfig({ mode: "report" as never }).mode).toBe("on");
	});
});

describe("reviewer — classifyFindingText", () => {
	it("classifies TODO/FIXME/bug/regression/broken as bug", () => {
		for (const t of ["- TODO: fix the leak", "FIXME: race condition", "this is a bug", "regression in parser", "broken on safari"]) {
			expect(classifyFindingText(t)).toBe("bug");
		}
	});
	it("classifies refactor-shaped text as refactor", () => {
		for (const t of ["could be cleaner", "consider refactoring the module", "duplicated logic", "deferred to v2"]) {
			expect(classifyFindingText(t)).toBe("refactor");
		}
	});
	it("classifies rewrite/new dependency/schema change as architectural", () => {
		expect(classifyFindingText("we should rewrite the auth layer")).toBe("architectural");
		expect(classifyFindingText("new dependency: add fastify")).toBe("architectural");
	});
	it("classifies 'should we'/'deprecate' as strategic", () => {
		expect(classifyFindingText("should we ship this?")).toBe("strategic");
		expect(classifyFindingText("deprecate the old API")).toBe("strategic");
	});
	it("returns undefined for code lines, tables, short lines, reviewer vocab", () => {
		expect(classifyFindingText("const x = 1;")).toBeUndefined();
		expect(classifyFindingText("| col | col |")).toBeUndefined();
		expect(classifyFindingText("short")).toBeUndefined();
		expect(classifyFindingText("architectural-class finding")).toBeUndefined();
	});
});

describe("reviewer — text helpers", () => {
	it("stripCodeSpans removes fenced + inline code", () => {
		// NOTE: the verbatim GLA regex yields THREE spaces here (space-before + replacement + space-after the inline span); the brief's 2-space value was a hand-computation typo. See task-1-report.md → Self-review.
		expect(stripCodeSpans("see `TODO` and\n```js\nTODO\n```")).toBe("see   and\n ");
	});
	it("unwrapHardWrappedLines joins lowercase continuations, leaves standalone items", () => {
		const joined = unwrapHardWrappedLines("Run a scan on the\nhellhunter codebase to");
		expect(joined).toBe("Run a scan on the hellhunter codebase to");
		const standalone = unwrapHardWrappedLines("TODO: fix x\nFIXME: fix y");
		expect(standalone).toBe("TODO: fix x\nFIXME: fix y");
	});
	it("cutAtClauseBoundary cuts at clause, then space, never mid-word", () => {
		expect(cutAtClauseBoundary("short", 200)).toBe("short");
		expect(cutAtClauseBoundary("a. b. c.", 4)).toBe("a.");
		const spaced = cutAtClauseBoundary("abcdefghijklmnopqrstuvwxyz", 10);
		expect(spaced.length).toBeLessThanOrEqual(10);
		expect(spaced).toBe("abcdefghij".slice(0, spaced.length)); // cut at a space or full window
	});
	it("normalizeObjective lowercases, collapses whitespace, masks goal-ids", () => {
		expect(normalizeObjective("Post-completion regression scan after 20260731120000-ab12cd (regression-scan)"))
			.toBe("post-completion regression scan after <id> (regression-scan)");
	});
});
