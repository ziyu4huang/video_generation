import { describe, expect, it } from "bun:test";
import {
	DEFAULT_REVIEWER_CONFIG,
	REVIEWER_REFIRE_WINDOW_MS,
	resolveReviewerConfig,
	classifyFindingText,
	stripCodeSpans,
	unwrapHardWrappedLines,
	cutAtClauseBoundary,
	normalizeObjective,
	ReviewerDeps,
	extractFindings,
	formatReviewReport,
	reviewerFiredRecently,
	reviewsToday,
	runReviewer,
} from "../reviewer.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

	describe("M-anti-pattern: false-positive completion-prose keywords (ticket 05)", () => {
		it("M-anti-pattern: 'no issues' / 'no issue' / 'without issues' does not trigger the reviewer", () => {
			// These are benign completion prose, not real bug signals
			expect(classifyFindingText("- no issues found")).toBeUndefined();
			expect(classifyFindingText("- no issue with the implementation")).toBeUndefined();
			expect(classifyFindingText("- completed without any issues")).toBeUndefined();
			expect(classifyFindingText("- this is a non-issue")).toBeUndefined();
			expect(classifyFindingText("- all tests pass, no issues")).toBeUndefined();
		});

		it("M-anti-pattern: 'added enhancements' / 'made improvements' does not trigger the reviewer", () => {
			// These are retrospective completion summaries, not "could be improved" signals
			expect(classifyFindingText("- added several improvements to the parser")).toBeUndefined();
			expect(classifyFindingText("- made enhancements to the UI")).toBeUndefined();
			expect(classifyFindingText("- added multiple enhancements")).toBeUndefined();
			expect(classifyFindingText("- made minor improvements")).toBeUndefined();
			expect(classifyFindingText("- included several small improvements")).toBeUndefined();
			expect(classifyFindingText("- implemented minor enhancements")).toBeUndefined();
		});

		it("M-anti-pattern: legitimate 'issue' detections still fire (no false negatives)", () => {
			// Real issue mentions should still be detected
			expect(classifyFindingText("- there is an issue with the auth flow")).toBe("bug");
			expect(classifyFindingText("- found a critical issue in the parser")).toBe("bug");
			expect(classifyFindingText("- TODO: investigate the issue")).toBe("bug");
			expect(classifyFindingText("- the issue causes a regression")).toBe("bug");
		});

		it("M-anti-pattern: legitimate 'improvement' detections still fire (no false negatives)", () => {
			// Real improvement signals (suggestions, not retrospective claims) should still be detected
			expect(classifyFindingText("- could be improved by adding caching")).toBe("refactor");
			expect(classifyFindingText("- this module could be improved")).toBe("refactor");
			expect(classifyFindingText("- consider adding improvement X")).toBe("refactor");
			expect(classifyFindingText("- would be nice to have an enhancement here")).toBe("refactor");
		});

		it("M-anti-pattern: mixed completion with false friends enqueues 0 items", () => {
			// A clean completion that says "no issues; added several enhancements"
			// should enqueue zero items (regression test from ticket 05)
			const out = extractFindings(
				[
					{ name: "summary", text: "no issues; added several enhancements" },
				],
				10,
			);
			expect(out).toEqual([]);
		});

		it("M-anti-pattern correction: mixed line keeps real signal (bug + false-friend improvement)", () => {
			// A line with BOTH a real bug signal AND a false-friend "added improvements"
			// should STILL fire the bug classification (not be suppressed)
			expect(classifyFindingText("Fixed the login bug and added several improvements")).toBe("bug");
			expect(classifyFindingText("Resolved the regression; made minor enhancements")).toBe("bug");
			expect(classifyFindingText("Fixed the broken parser and implemented multiple enhancements")).toBe("bug");
		});

		it("M-anti-pattern correction: mixed line keeps real signal (refactor + false-friend issue)", () => {
			// A line with BOTH a real refactor signal AND a false-friend "no issues"
			// should STILL fire the refactor classification (not be suppressed)
			expect(classifyFindingText("Refactored the module; no issues elsewhere")).toBe("refactor");
			expect(classifyFindingText("Consider refactoring X; there are no issues with Y")).toBe("refactor");
		});

		it("M-anti-pattern correction: pure false-friend lines still suppressed", () => {
			// Pure false-friend lines (no real signal) should still be suppressed
			expect(classifyFindingText("no issues found")).toBeUndefined();
			expect(classifyFindingText("completed without any issues")).toBeUndefined();
			expect(classifyFindingText("added several improvements to the parser")).toBeUndefined();
			expect(classifyFindingText("made minor enhancements")).toBeUndefined();
		});

		it("M-anti-pattern correction: real signals still fire (not adjacent to false friends)", () => {
			// Real bug/refactor signals that are NOT adjacent to false-friend phrases
			// should still be detected (no regression from the fix)
			expect(classifyFindingText("there is a bug in the auth flow")).toBe("bug");
			expect(classifyFindingText("found an issue with the parser")).toBe("bug");
			expect(classifyFindingText("could be improved by adding caching")).toBe("refactor");
			expect(classifyFindingText("this module could be cleaner")).toBe("refactor");
		});

		it("M-anti-pattern: a genuine 'TODO: fix the broken loader' finding still enqueues", () => {
			// Real findings must still be detected (no false negatives)
			const out = extractFindings(
				[
					{ name: "summary", text: "- TODO: fix the broken loader" },
				],
				10,
			);
			expect(out).toHaveLength(1);
			expect(out[0].class).toBe("bug");
			expect(out[0].text).toContain("fix the broken loader");
		});
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

describe("reviewer — extractFindings", () => {
	it("extracts + dedupes findings across sources, caps at max", () => {
		const out = extractFindings(
			[
				{ name: "summary", text: "- TODO: fix leak\n- TODO: fix leak\n- consider refactoring X" },
				{ name: "audit", text: "broken on safari" },
			],
			10,
		);
		expect(out.map((f) => f.class).sort()).toEqual(["bug", "bug", "refactor"]);
		expect(new Set(out.map((f) => f.text)).size).toBe(out.length); // deduped
	});
	it("drops dangling-connector fragments + objective restatements", () => {
		const out = extractFindings(
			[{ name: "s", text: "Run a scan on the codebase to" }],
			10,
			"Run a scan on the codebase to find bugs",
		);
		expect(out).toEqual([]);
	});
});

describe("reviewer — report + safety", () => {
	it("formatReviewReport renders sections per class", () => {
		const r = formatReviewReport({
			goalId: "g1", kind: "goal", objective: "ship it",
			findings: [{ text: "TODO: x", source: "summary", class: "bug" }],
			cascadeStep: "convert-findings-to-list", mode: "on", at: "2026-07-31T00:00:00.000Z",
		});
		expect(r).toContain("Bug-class");
		expect(r).toContain("TODO: x");
	});
	it("writeReviewReport writes a file under <cwd>/.pi/core-task/reviews/", () => {
		const dir = mkdtempSync(join(tmpdir(), "rev-"));
		try {
			const p = runWriteReport(dir);
			expect(readFileSync(p, "utf8")).toContain("Review — g1");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it("reviewerFiredRecently + reviewsToday read ledger entries", () => {
		const now = Date.parse("2026-07-31T12:00:00.000Z");
		const entries = [{ type: "reviewer_fired", at: "2026-07-31T11:58:00.000Z" }];
		expect(reviewerFiredRecently(entries, REVIEWER_REFIRE_WINDOW_MS, now)).toBe(true);
		expect(reviewerFiredRecently(entries, REVIEWER_REFIRE_WINDOW_MS, now + 10 * 60_000)).toBe(false);
		expect(reviewsToday(entries, now)).toBe(1);
	});
});

// helper for the writeReport test (writeReviewReport path differs from GLA's .pi-gla path — see adaptation below)
function runWriteReport(cwd: string): string {
	const { writeReviewReport } = require("../reviewer.js");
	return writeReviewReport(cwd, {
		goalId: "g1", kind: "goal", objective: "o",
		findings: [], cascadeStep: "notify-and-idle", mode: "on", at: "2026-07-31T00:00:00.000Z",
	});
}

describe("reviewer — runReviewer cascade (on mode)", () => {
	const baseSource = { kind: "goal" as const, goalId: "g1", objective: "ship feature X", terminal: "goal-complete" };
	function depsFor(sourcesText: string) {
		const enqueued: string[] = [];
		const proposed: Array<{ objective: string; reason: string }> = [];
		const notified: Array<{ m: string; lvl: string }> = [];
		const ledger: Array<{ type: string; value: Record<string, unknown> }> = [];
		const cwd = mkdtempSync(join(tmpdir(), "rev-"));
		return {
			deps: {
				cwd, nowMs: Date.parse("2026-07-31T12:00:00.000Z"), ledgerEntries: [],
				sources: [{ name: "summary", text: sourcesText }],
				enqueueListItems: (o: string[]) => { enqueued.push(...o); },
				proposeGoal: (objective: string, reason: string) => { proposed.push({ objective, reason }); return true; },
				notify: (m: string, lvl: "info" | "warning") => { notified.push({ m, lvl }); },
				ledger: (type: string, value: Record<string, unknown>) => { ledger.push({ type, value }); },
			} satisfies ReviewerDeps,
			cleanup: () => rmSync(cwd, { recursive: true, force: true }),
			assert: { enqueued, proposed, notified, ledger },
		};
	}

	it("bug/refactor findings -> enqueueListItems (no proposeGoal)", () => {
		const h = depsFor("- TODO: fix leak\n- consider refactoring Y");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, h.deps);
			expect(out.fired).toBe(true);
			expect(h.assert.enqueued).toHaveLength(2);
			expect(h.assert.proposed).toHaveLength(0);
			expect(out.cascadeStep).toBe("convert-findings-to-list");
		} finally { h.cleanup(); }
	});

	it("architectural finding -> proposeGoal (Confirm-gated by wiring, not here)", () => {
		const h = depsFor("- we should rewrite the auth layer");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, h.deps);
			expect(h.assert.proposed).toHaveLength(1);
			expect(h.assert.proposed[0].objective).toContain("rewrite the auth layer");
			expect(out.cascadeStep).toBe("propose-goal");
		} finally { h.cleanup(); }
	});

	it("clean completion -> regression-scan proposeGoal", () => {
		const h = depsFor("all done, nothing left");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, h.deps);
			expect(h.assert.proposed).toHaveLength(1);
			expect(h.assert.proposed[0].objective).toContain("regression scan");
			expect(out.cascadeStep).toBe("fire-audit-on-clean");
		} finally { h.cleanup(); }
	});

	it("duplicate-scan: a scan objective completing does NOT re-propose the same scan", () => {
		const scanSource = { ...baseSource, objective: "Post-completion regression scan after g1 (regression-scan)" };
		const h = depsFor("nothing left");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, scanSource, h.deps);
			expect(out.cascadeStep).toBe("duplicate-suppressed");
			expect(h.assert.proposed).toHaveLength(0);
		} finally { h.cleanup(); }
	});

	it("suppressed when disabled", () => {
		const h = depsFor("- TODO: x");
		try {
			const out = runReviewer({ ...DEFAULT_REVIEWER_CONFIG, enabled: false }, baseSource, h.deps);
			expect(out.fired).toBe(false);
			expect(out.suppressedReason).toMatch(/disabled|off/);
		} finally { h.cleanup(); }
	});

	it("suppressed within the refire window", () => {
		const cwd = mkdtempSync(join(tmpdir(), "rev-"));
		try {
			const now = Date.parse("2026-07-31T12:00:00.000Z");
			const deps = {
				cwd, nowMs: now, ledgerEntries: [{ type: "reviewer_fired", at: "2026-07-31T11:58:00.000Z" }],
				sources: [{ name: "s", text: "- TODO: x" }],
				enqueueListItems: () => {}, proposeGoal: () => true, notify: () => {}, ledger: () => {},
			};
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, deps);
			expect(out.fired).toBe(false);
			expect(out.suppressedReason).toMatch(/5 minutes|runaway/);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("wrong terminal (paused) never fires", () => {
		const h = depsFor("- TODO: x");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, { ...baseSource, terminal: "goal-paused" }, h.deps);
			expect(out.fired).toBe(false);
		} finally { h.cleanup(); }
	});
});

describe("reviewer — runReviewer cascade (auto mode)", () => {
	const baseSource = { kind: "goal" as const, goalId: "g1", objective: "ship feature X", terminal: "goal-complete" };
	function depsFor(sourcesText: string) {
		const enqueued: string[] = [];
		const proposed: Array<{ objective: string; reason: string }> = [];
		const notified: Array<{ m: string; lvl: string }> = [];
		const ledger: Array<{ type: string; value: Record<string, unknown> }> = [];
		const cwd = mkdtempSync(join(tmpdir(), "rev-"));
		return {
			deps: {
				cwd, nowMs: Date.parse("2026-07-31T12:00:00.000Z"), ledgerEntries: [],
				sources: [{ name: "summary", text: sourcesText }],
				enqueueListItems: (o: string[]) => { enqueued.push(...o); },
				proposeGoal: (objective: string, reason: string) => { proposed.push({ objective, reason }); return true; },
				notify: (m: string, lvl: "info" | "warning") => { notified.push({ m, lvl }); },
				ledger: (type: string, value: Record<string, unknown>) => { ledger.push({ type, value }); },
			} satisfies ReviewerDeps,
			cleanup: () => rmSync(cwd, { recursive: true, force: true }),
			assert: { enqueued, proposed, notified, ledger },
		};
	}

	it("auto mode: bug/refactor findings -> enqueueListItems (no Confirm)", () => {
		const h = depsFor("- TODO: fix leak\n- consider refactoring Y");
		try {
			const autoConfig = { ...DEFAULT_REVIEWER_CONFIG, mode: "auto" as const };
			const out = runReviewer(autoConfig, baseSource, h.deps);
			expect(out.fired).toBe(true);
			expect(h.assert.enqueued).toHaveLength(2);
			expect(h.assert.proposed).toHaveLength(0);
			expect(out.cascadeStep).toBe("convert-findings-to-list");
		} finally { h.cleanup(); }
	});

	it("auto mode: architectural findings -> enqueueListItems (no Confirm, unlike 'on' mode)", () => {
		const h = depsFor("- we should rewrite the auth layer");
		try {
			const autoConfig = { ...DEFAULT_REVIEWER_CONFIG, mode: "auto" as const };
			const out = runReviewer(autoConfig, baseSource, h.deps);
			expect(h.assert.enqueued).toHaveLength(1);
			expect(h.assert.proposed).toHaveLength(0); // auto mode: no Confirm
			expect(out.cascadeStep).toBe("convert-findings-to-list");
		} finally { h.cleanup(); }
	});

	it("auto mode: clean completion -> enqueue audit (no Confirm)", () => {
		const h = depsFor("all done, nothing left");
		try {
			const autoConfig = { ...DEFAULT_REVIEWER_CONFIG, mode: "auto" as const };
			const out = runReviewer(autoConfig, baseSource, h.deps);
			expect(h.assert.enqueued).toHaveLength(1);
			expect(h.assert.enqueued[0]).toContain("regression scan");
			expect(h.assert.proposed).toHaveLength(0); // auto mode: no Confirm
			expect(out.cascadeStep).toBe("fire-audit-on-clean");
		} finally { h.cleanup(); }
	});
});

describe("reviewer — runReviewer cascade (aggressive mode)", () => {
	const baseSource = { kind: "goal" as const, goalId: "g1", objective: "ship feature X", terminal: "goal-complete" };
	function depsFor(sourcesText: string) {
		const enqueued: string[] = [];
		const proposed: Array<{ objective: string; reason: string }> = [];
		const notified: Array<{ m: string; lvl: string }> = [];
		const ledger: Array<{ type: string; value: Record<string, unknown> }> = [];
		const cwd = mkdtempSync(join(tmpdir(), "rev-"));
		return {
			deps: {
				cwd, nowMs: Date.parse("2026-07-31T12:00:00.000Z"), ledgerEntries: [],
				sources: [{ name: "summary", text: sourcesText }],
				enqueueListItems: (o: string[]) => { enqueued.push(...o); },
				proposeGoal: (objective: string, reason: string) => { proposed.push({ objective, reason }); return true; },
				notify: (m: string, lvl: "info" | "warning") => { notified.push({ m, lvl }); },
				ledger: (type: string, value: Record<string, unknown>) => { ledger.push({ type, value }); },
			} satisfies ReviewerDeps,
			cleanup: () => rmSync(cwd, { recursive: true, force: true }),
			assert: { enqueued, proposed, notified, ledger },
		};
	}

	it("aggressive mode: bug/refactor findings -> enqueueListItems", () => {
		const h = depsFor("- TODO: fix leak\n- consider refactoring Y");
		try {
			const aggressiveConfig = { ...DEFAULT_REVIEWER_CONFIG, mode: "aggressive" as const };
			const out = runReviewer(aggressiveConfig, baseSource, h.deps);
			expect(out.fired).toBe(true);
			expect(h.assert.enqueued).toHaveLength(2);
			expect(h.assert.proposed).toHaveLength(0);
			expect(out.cascadeStep).toBe("convert-findings-to-list");
		} finally { h.cleanup(); }
	});

	it("aggressive mode: architectural findings -> enqueue + propose relaunch (no Confirm, burns through queue)", () => {
		const h = depsFor("- we should rewrite the auth layer\n- new dependency: fastify");
		try {
			const aggressiveConfig = { ...DEFAULT_REVIEWER_CONFIG, mode: "aggressive" as const };
			const out = runReviewer(aggressiveConfig, baseSource, h.deps);
			expect(h.assert.enqueued).toHaveLength(2); // both enqueued
			expect(h.assert.proposed).toHaveLength(1); // first one proposed for relaunch
			expect(h.assert.proposed[0].objective).toContain("rewrite the auth layer");
			expect(h.assert.proposed[0].reason).toContain("aggressive");
			expect(out.cascadeStep).toBe("aggressive-relaunch");
		} finally { h.cleanup(); }
	});

	it("aggressive mode: clean completion -> propose audit relaunch (no Confirm)", () => {
		const h = depsFor("all done, nothing left");
		try {
			const aggressiveConfig = { ...DEFAULT_REVIEWER_CONFIG, mode: "aggressive" as const };
			const out = runReviewer(aggressiveConfig, baseSource, h.deps);
			expect(h.assert.enqueued).toHaveLength(0);
			expect(h.assert.proposed).toHaveLength(1);
			expect(h.assert.proposed[0].objective).toContain("regression scan");
			expect(h.assert.proposed[0].reason).toContain("aggressive");
			expect(out.cascadeStep).toBe("aggressive-relaunch");
		} finally { h.cleanup(); }
	});
});

describe("reviewer — kind:'list' path (queue emptying)", () => {
	const listSource = { kind: "list" as const, goalId: "queue-1", objective: "/list queue emptied", terminal: "list-complete" };
	function depsFor(sourcesText: string) {
		const enqueued: string[] = [];
		const proposed: Array<{ objective: string; reason: string }> = [];
		const notified: Array<{ m: string; lvl: string }> = [];
		const ledger: Array<{ type: string; value: Record<string, unknown> }> = [];
		const cwd = mkdtempSync(join(tmpdir(), "rev-"));
		return {
			deps: {
				cwd, nowMs: Date.parse("2026-07-31T12:00:00.000Z"), ledgerEntries: [],
				sources: [{ name: "summary", text: sourcesText }],
				enqueueListItems: (o: string[]) => { enqueued.push(...o); },
				proposeGoal: (objective: string, reason: string) => { proposed.push({ objective, reason }); return true; },
				notify: (m: string, lvl: "info" | "warning") => { notified.push({ m, lvl }); },
				ledger: (type: string, value: Record<string, unknown>) => { ledger.push({ type, value }); },
			} satisfies ReviewerDeps,
			cleanup: () => rmSync(cwd, { recursive: true, force: true }),
			assert: { enqueued, proposed, notified, ledger },
		};
	}

	it("list-complete with findings -> queue-leftovers cascade (not convert-findings-to-list)", () => {
		const h = depsFor("- TODO: fix leak from queue");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, listSource, h.deps);
			expect(out.fired).toBe(true);
			expect(h.assert.enqueued).toHaveLength(1);
			expect(out.cascadeStep).toBe("queue-leftovers");
			expect(h.assert.notified[0].m).toContain("queue-leftovers");
		} finally { h.cleanup(); }
	});

	it("list-complete in auto mode -> queue-leftovers with no Confirm", () => {
		const h = depsFor("- we should redesign the queue system");
		try {
			const autoConfig = { ...DEFAULT_REVIEWER_CONFIG, mode: "auto" as const };
			const out = runReviewer(autoConfig, listSource, h.deps);
			expect(h.assert.enqueued).toHaveLength(1);
			expect(h.assert.proposed).toHaveLength(0);
			expect(out.cascadeStep).toBe("queue-leftovers");
		} finally { h.cleanup(); }
	});

	it("list-complete clean -> fire-audit-on-clean (same as goal-complete)", () => {
		const h = depsFor("all queue items completed cleanly");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, listSource, h.deps);
			// Clean list completion fires audit (same as goal-complete)
			expect(out.cascadeStep).toBe("fire-audit-on-clean");
			expect(h.assert.proposed).toHaveLength(1);
			expect(h.assert.proposed[0].objective).toContain("regression scan");
		} finally { h.cleanup(); }
	});
});
