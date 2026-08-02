/**
 * Schema-cost heuristic agreement (ticket 03 fold-in).
 *
 * tool-gate ships an INLINED copy of the token heuristic in `measureToolTokens`
 * (extensions/tool-gate.ts) — inlined deliberately so this always-on extension
 * stays decoupled from power-tool at runtime. power-tool's
 * `@repo/pi-agent-ext-power-tool/schema-cost` submodule owns the CANONICAL
 * `estimateToolCost`. If the two heuristics drift, tool-gate's banner savings
 * figure silently disagrees with the schema-cost CLI — this test pins them.
 *
 * Both compute `Math.round((description.length + JSON.stringify(parameters).length) / 4)`.
 * This is a dev-time cross-package test import (allowed by ticket 03: test-time
 * imports between extensions are acceptable; only runtime ext↔ext deps are
 * forbidden).
 */
import { describe, expect, test } from "bun:test";
import { measureToolTokens } from "./tool-gate.ts";
import { estimateToolCost } from "@repo/pi-agent-ext-power-tool/schema-cost";

const SAMPLE_DEFS = [
	{ name: "read", description: "Read the contents of a file.", parameters: { type: "object", properties: { path: { type: "string" } } } },
	{ name: "empty", description: "", parameters: {} },
	{ name: "big", description: "x".repeat(200), parameters: { type: "object", properties: { a: { type: "string", description: "d".repeat(50) } } } },
];

describe("schema-cost heuristic agreement (tool-gate inline == power-tool canonical)", () => {
	test("estimateToolCost is exported from the schema-cost subpath", () => {
		// Structural guard: the import above already fails the test file to load
		// if the export is missing; this makes the intent explicit.
		expect(typeof estimateToolCost).toBe("function");
		expect(typeof measureToolTokens).toBe("function");
	});

	test("measureToolTokens matches estimateToolCost().approxTokens across samples", () => {
		for (const def of SAMPLE_DEFS) {
			const inline = measureToolTokens(def);
			const canonical = estimateToolCost(def, "(test)").approxTokens;
			expect(inline, `def "${def.name}"`).toBe(canonical);
		}
	});

	test("the canonical field is `approxTokens` (guard against a rename silently breaking the agreement)", () => {
		const r = estimateToolCost(SAMPLE_DEFS[0], "(test)");
		expect(r).toHaveProperty("approxTokens");
		expect(typeof r.approxTokens).toBe("number");
	});
});
