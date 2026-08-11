import { describe, expect, test } from "bun:test";
import {
	estimateToolCost,
	estimateTokens,
	analyzeTools,
	mergeReports,
	formatReport,
	formatJson,
	DEFAULT_CHARS_PER_TOKEN,
} from "../index.ts";
import type { ToolDefinitionLike } from "../index.ts";

// ─── Golden fixture: the same tool set the pi-agent schema-cost command ranks
// These mirror real tool shapes (a builtin + two extensions). The parity
// contract: estimateToolCost + analyzeTools produce IDENTICAL numbers to the
// pi-agent heuristic, byte-for-byte, on this fixture.
const GOLDEN: { def: ToolDefinitionLike; source: string }[] = [
	{
		def: { name: "read", description: "Read the contents of a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		source: "(builtin)",
	},
	{
		def: { name: "search", description: "Search the web. Returns an answer with citations. Multiple providers.", parameters: { type: "object", properties: { query: { type: "string" }, queries: { type: "array", items: { type: "string" } } }, required: ["query"] } },
		source: "web-access",
	},
	{
		def: { name: "beep", description: "Beep.", parameters: { type: "object" } },
		source: "power-tool",
	},
];

describe("estimateTokens", () => {
	test("default ratio is 4", () => {
		expect(DEFAULT_CHARS_PER_TOKEN).toBe(4);
		expect(estimateTokens(40)).toBe(10);
		expect(estimateTokens(0)).toBe(0);
	});
	test("live instrument ratio is the default (unified — no 3.7/4.0 drift)", () => {
		// inspect_context (src/index.ts TOKEN_RATIO) now sources
		// DEFAULT_CHARS_PER_TOKEN, so the live + static instruments agree.
		expect(DEFAULT_CHARS_PER_TOKEN).toBe(4);
		expect(estimateTokens(40, DEFAULT_CHARS_PER_TOKEN)).toBe(10);
	});
	test("rounds (not truncates)", () => {
		expect(estimateTokens(6)).toBe(2); // round(1.5)=2 (banker's-free; Math.round(1.5)=2)
		expect(estimateTokens(10)).toBe(3); // round(2.5)=3 → wait round(10/4)=round(2.5)=3? Math.round(2.5)=3
	});
});

describe("estimateToolCost — golden parity", () => {
	test("produces the canonical ToolCost shape + numbers", () => {
		const c = estimateToolCost(GOLDEN[0]!.def, GOLDEN[0]!.source);
		expect(c.name).toBe("read");
		expect(c.source).toBe("(builtin)");
		// descLen = "Read the contents of a file.".length = 28
		expect(c.descLen).toBe(28);
		// paramsLen = JSON.stringify(parameters).length — assert deterministic
		const expectedParamsLen = JSON.stringify(GOLDEN[0]!.def.parameters).length;
		expect(c.paramsLen).toBe(expectedParamsLen);
		expect(c.approxTokens).toBe(Math.round((28 + expectedParamsLen) / 4));
	});

	test("handles missing/optional fields gracefully", () => {
		expect(estimateToolCost({}, "x").name).toBe("?");
		expect(estimateToolCost({ name: "a" }, "x").approxTokens).toBe(0);
		expect(estimateToolCost({ name: "a", description: 123 }, "x").descLen).toBe(0); // non-string desc
		expect(estimateToolCost({ name: "a", parameters: "not-object" }, "x").paramsLen).toBe(0);
		expect(estimateToolCost(null, "x").name).toBe("?");
	});

	test("respects custom charsPerToken", () => {
		const at4 = estimateToolCost(GOLDEN[1]!.def, "x");
		const at35 = estimateToolCost(GOLDEN[1]!.def, "x", { charsPerToken: 3.5 });
		expect(at35.approxTokens).toBeGreaterThan(at4.approxTokens); // smaller ratio → more tokens
	});
});

describe("analyzeTools — ranking parity", () => {
	test("sorts desc by approxTokens, tie-breaks by name", () => {
		const report = analyzeTools(GOLDEN.map((g) => g.def), "mixed");
		// 'search' has the longest desc+params → rank 1; 'beep' is smallest → rank 3
		expect(report.tools[0]!.name).toBe("search");
		expect(report.tools[2]!.name).toBe("beep");
		expect(report.totalTokens).toBe(report.tools.reduce((s, t) => s + t.approxTokens, 0));
		expect(report.extensionCount).toBe(3);
		expect(report.builtinCount).toBe(0); // analyzeTools is source-agnostic
		expect(report.errors).toEqual([]);
	});

	test("empty input → empty report", () => {
		const r = analyzeTools([], "x");
		expect(r.tools).toEqual([]);
		expect(r.totalTokens).toBe(0);
	});

	test("deterministic across runs (stability)", () => {
		const a = analyzeTools(GOLDEN.map((g) => g.def), "x");
		const b = analyzeTools(GOLDEN.map((g) => g.def), "x");
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("mergeReports", () => {
	test("consolidates per-source lists, counts builtins by source", () => {
		const builtins = [estimateToolCost(GOLDEN[0]!.def, "(builtin)")];
		const exts = [estimateToolCost(GOLDEN[1]!.def, "web"), estimateToolCost(GOLDEN[2]!.def, "power")];
		const merged = mergeReports([builtins, exts]);
		expect(merged.tools.length).toBe(3);
		expect(merged.builtinCount).toBe(1);
		expect(merged.extensionCount).toBe(2);
		expect(merged.tools[0]!.name).toBe("search"); // still ranked by cost
	});
});

describe("formatReport / formatJson — output parity", () => {
	const report = analyzeTools(GOLDEN.map((g) => g.def), "mixed");

	test("formatReport header line carries count + total + the demand story", () => {
		const lines = formatReport(report);
		expect(lines[0]).toContain("schema-cost —");
		expect(lines[0]).toContain("tools");
		expect(lines[0]).toContain("tokens");
		expect(lines.some((l) => l.includes("top 3"))).toBe(true);
		expect(lines.some((l) => l.includes("tool") && l.includes("tokens"))).toBe(true); // table header
		expect(lines.some((l) => l.includes("search"))).toBe(true);
	});

	test("formatJson is valid JSON with the ranked tool list", () => {
		const j = JSON.parse(formatJson(report));
		expect(j.totalTokens).toBe(report.totalTokens);
		expect(j.toolsRanked[0].name).toBe("search");
		expect(j.toolsRanked.every((t: { approxTokens: number }) => typeof t.approxTokens === "number")).toBe(true);
	});

	test("formatReport handles zero-total (no division error)", () => {
		const empty = formatReport({ ...report, tools: [], totalTokens: 0 });
		expect(empty[0]).toContain("0 tools");
	});
});

describe("PARITY CONTRACT — submodule matches pi-agent schema-cost logic", () => {
	// The decisive test: the submodule's estimateToolCost MUST produce the same
	// approxTokens as the CLI heuristic `Math.round((desc.length + paramsLen) / 4)`
	// on the golden fixture. This is what makes CLI delegation safe.
	test("estimateToolCost == CLI heuristic on golden fixture", () => {
		for (const g of GOLDEN) {
			const def = g.def as { name?: string; description?: string; parameters?: unknown };
			const descLen = (def.description ?? "").length;
			const paramsLen = def.parameters && typeof def.parameters === "object" ? JSON.stringify(def.parameters).length : 0;
			const cliApprox = Math.round((descLen + paramsLen) / 4); // ← the CLI formula
			const pkg = estimateToolCost(g.def, g.source);
			expect(pkg.approxTokens).toBe(cliApprox);
			expect(pkg.descLen).toBe(descLen);
			expect(pkg.paramsLen).toBe(paramsLen);
		}
	});
});
