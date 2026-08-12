/**
 * Tests for the coverage analyzer (close the measurement→action loop).
 *
 * The pure core (analyzeCoverage) is exercised against a hand-crafted
 * SchemaCostReport fixture — no agent boot, no repo discovery. One structural
 * integration test (measureCoverage) runs the real collector at the end.
 */
import { describe, expect, it } from "bun:test";
import {
	analyzeCoverage,
	formatCoverage,
	assertSane,
	DEFAULT_COVERAGE_THRESHOLD,
} from "./coverage.ts";
// Types are sourced from power-tool's canonical schema-cost submodule directly
// (pi-agent's schema-cost command re-exported them as a @deprecated delegate;
// that alias was removed in the gating-field migration Task 5).
import type { SchemaCostReport, ToolCost } from "@repo/pi-agent-ext-power-tool/schema-cost";

/** Minimal ToolCost fixture — only the fields analyzeCoverage reads matter. */
const tool = (name: string, approxTokens: number, source: string): ToolCost =>
	({ name, descLen: 0, paramsLen: 0, approxTokens, source }) as ToolCost;

/** Build a SchemaCostReport shell from a tool list (totals derived). */
function report(tools: ToolCost[]): SchemaCostReport {
	return {
		tools,
		totalTokens: tools.reduce((s, t) => s + t.approxTokens, 0),
		builtinCount: tools.filter((t) => t.source === "(builtin)").length,
		extensionCount: tools.filter((t) => t.source !== "(builtin)").length,
		errors: [],
	} as SchemaCostReport;
}

const ROOT = "/fake/repo";
const TH = DEFAULT_COVERAGE_THRESHOLD; // 300

describe("analyzeCoverage", () => {
	it("reports a heavy tool NOT tracked as ungated", () => {
		const r = analyzeCoverage(report([tool("synthetic_heavy", 500, "some-ext")]), TH, ROOT);
		expect(r.ungated.map((u) => u.name)).toEqual(["synthetic_heavy"]);
		expect(r.heavyTools).toBe(1);
		expect(r.gatedHeavy).toBe(0);
		expect(r.pass).toBe(false);
	});

	it("counts a heavy TRACKED tool as gatedHeavy (not ungated)", () => {
		// Post ticket 13a analyzeCoverage defaults `tracked` to CORPUS_EFF.tracked
		// (core ∪ owner-declared gated names) — NOT the legacy module TRACKED_TOOLS.
		// "enable_tool" is a CORE_TOOLS member → in CORPUS_EFF.tracked (the source
		// string is synthetic; analyzeCoverage only skips source === "(builtin)").
		// This proves the tracked→gatedHeavy path under the effective-gates default.
		const r = analyzeCoverage(report([tool("enable_tool", 500, "zai-mcp")]), TH, ROOT);
		expect(r.gatedHeavy).toBe(1);
		expect(r.ungated).toEqual([]);
		expect(r.pass).toBe(true);
	});

	it("never reports a builtin, even if heavy", () => {
		const r = analyzeCoverage(report([tool("bash", 9999, "(builtin)")]), TH, ROOT);
		expect(r.ungated).toEqual([]);
		expect(r.heavyTools).toBe(0); // builtins excluded from the heavy count
		expect(r.gatedHeavy).toBe(0);
		expect(r.pass).toBe(true);
	});

	it("ignores sub-threshold tools", () => {
		const r = analyzeCoverage(report([tool("synthetic_small", 100, "some-ext")]), TH, ROOT);
		expect(r.ungated).toEqual([]);
		expect(r.heavyTools).toBe(0);
		expect(r.pass).toBe(true);
	});

	it("sorts ungated desc by tokens", () => {
		const r = analyzeCoverage(
			report([tool("a", 400, "x"), tool("b", 900, "x"), tool("c", 600, "x")]),
			TH,
			ROOT,
		);
		expect(r.ungated.map((u) => u.name)).toEqual(["b", "c", "a"]);
	});

	it("respects a threshold override lower than default", () => {
		// 250 < default 300 but >= 200 → caught only under the override
		const r = analyzeCoverage(report([tool("synthetic_mid", 250, "x")]), 200, ROOT);
		expect(r.ungated.map((u) => u.name)).toEqual(["synthetic_mid"]);
		expect(r.threshold).toBe(200);
	});

	it("passes root through to the report", () => {
		const r = analyzeCoverage(report([]), TH, ROOT);
		expect(r.root).toBe(ROOT);
		expect(r.totalTools).toBe(0);
	});
});

describe("formatCoverage", () => {
	it("renders a healthy (✅) report when nothing is ungated", () => {
		const r = analyzeCoverage(report([tool("enable_tool", 500, "md")]), TH, ROOT);
		const out = formatCoverage(r).join("\n");
		expect(out).toContain("✅");
		expect(out).not.toContain("NOT gated");
	});

	it("renders a gap (❌) + the ungated tool list when something is missing", () => {
		const r = analyzeCoverage(report([tool("synthetic_heavy", 500, "x")]), TH, ROOT);
		const out = formatCoverage(r).join("\n");
		expect(out).toContain("❌");
		expect(out).toContain("synthetic_heavy");
	});

	it("flags collection errors as a lower-bound caveat", () => {
		const rep = report([tool("synthetic_heavy", 500, "x")]);
		rep.errors = [{ source: "broken-ext", error: "factory threw" }];
		const r = analyzeCoverage(rep, TH, ROOT);
		expect(r.errors.length).toBe(1);
		const out = formatCoverage(r).join("\n");
		expect(out).toContain("LOWER BOUND");
		expect(out).toContain("1 collection error");
	});
});

describe("assertSane", () => {
	it("flags a non-positive threshold", () => {
		const r = analyzeCoverage(report([tool("enable_tool", 500, "md")]), -1, ROOT);
		expect(assertSane(r).some((p) => p.includes("threshold"))).toBe(true);
	});

	it("flags a NaN threshold", () => {
		const r = analyzeCoverage(report([tool("enable_tool", 500, "md")]), NaN, ROOT);
		expect(assertSane(r).some((p) => p.includes("threshold"))).toBe(true);
	});

	it("flags an empty report (no tools captured)", () => {
		const r = analyzeCoverage(report([]), TH, ROOT);
		expect(assertSane(r).some((p) => p.includes("no tools"))).toBe(true);
	});

	it("is clean for a normal report", () => {
		const r = analyzeCoverage(report([tool("enable_tool", 500, "md")]), TH, ROOT);
		expect(assertSane(r)).toEqual([]);
	});
});

describe("measureCoverage (integration — real repo)", () => {
	it("collects the real repo and is structurally sane", async () => {
		const { measureCoverage } = await import("./coverage.ts");
		const r = await measureCoverage();
		// Structural sanity (NOT a brittle count): the repo has tools and the
		// collector didn't fall over. The exact ungated count is intentionally
		// NOT asserted — a non-zero ungated is a real finding, not a test failure.
		expect(r.totalTools).toBeGreaterThan(0);
		expect(assertSane(r)).toEqual([]);
		// The repo gates at least one heavy tool (e.g. flux2 / ltx / movie-*).
		expect(r.gatedHeavy).toBeGreaterThanOrEqual(1);
	}, 15000); // 15s timeout for integration test (offline collection may be slow)
});
