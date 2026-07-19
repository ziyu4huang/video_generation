/**
 * stealth-trim.test.ts — regression guard: the `ltx` tool must stay
 * context-trimmed (short routing description, no promptSnippet/promptGuidelines).
 * Bulk semantics live in the on-demand `ltx_help` tool, not the static schema.
 *
 * Captures the registered tool via the extension factory + a mock pi (same
 * capturing pattern `tools-metrics --schema-cost` uses), so this tests the
 * ACTUAL tool definition the LLM sees — without exporting internals.
 */
import { test, expect } from "bun:test";
import extensionFactory from "../ltx.ts";

function captureTools(): Record<string, Record<string, unknown>> {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (t: Record<string, unknown>) => {
			tools[t.name as string] = t;
		},
		on(_event: string, _handler: (...args: any[]) => void) {
			// no-op: session_start handler not exercised in unit tests
		},
		getActiveTools: () => [],
		setActiveTools: (_tools: string[]) => {},
	};
	extensionFactory(mockPi as never);
	return tools;
}

test("ltx tool is stealth-trimmed: short routing description + no promptSnippet/guidelines", () => {
	const tools = captureTools();
	const ltx = tools["ltx"];
	expect(ltx).toBeDefined();

	const desc = String(ltx.description ?? "");
	// Routing one-liner, NOT the ~933-tok essay with commandIndex() inline.
	expect(desc.length).toBeLessThan(220);
	// Must still point the model at on-demand help.
	expect(desc).toMatch(/ltx_help/);
	// Stealth: no per-turn system-prompt injection (help already carries usage).
	expect(ltx.promptSnippet).toBeUndefined();
	expect(ltx.promptGuidelines).toBeUndefined();
});
