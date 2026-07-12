/**
 * stealth-trim.test.ts — regression guard: the `flux2` tool must stay
 * context-trimmed (short routing description, no promptSnippet/promptGuidelines).
 * Bulk semantics live in the on-demand `flux2_help` tool, not the static schema.
 */
import { test, expect } from "bun:test";
import extensionFactory from "../pi-flux2.ts";

function captureTools(): Record<string, Record<string, unknown>> {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (t: Record<string, unknown>) => {
			tools[t.name as string] = t;
		},
	};
	extensionFactory(mockPi as never);
	return tools;
}

test("flux2 tool is stealth-trimmed: short routing description + no promptSnippet/guidelines", () => {
	const tools = captureTools();
	const flux2 = tools["flux2"];
	expect(flux2).toBeDefined();

	const desc = String(flux2.description ?? "");
	expect(desc.length).toBeLessThan(240);
	expect(desc).toMatch(/flux2_help/);
	expect(flux2.promptSnippet).toBeUndefined();
	expect(flux2.promptGuidelines).toBeUndefined();
});
