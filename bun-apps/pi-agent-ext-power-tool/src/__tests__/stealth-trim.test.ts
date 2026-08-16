/**
 * stealth-trim.test.ts — regression guard: power-tool's registered tools
 * (6 inspect_* diagnostics + the gated browser tool) must stay free of
 * per-turn `promptSnippet`. (They have no promptGuidelines field —
 * the many `promptGuidelines` references in index.ts are either fixture data
 * in SELF_TEST_ANALYSIS_INPUT or inspection LOGIC that reads OTHER tools'
 * fields; those are NOT trimmed.)
 *
 * Mirrors the mockPi shape from index.test.ts but captures the FULL tool def
 * (so promptSnippet is observable), then asserts it's absent on each inspect_*.
 */
import { test, expect } from "bun:test";
import extension from "../index.ts";

function captureInspectTools(): Record<string, Record<string, unknown>> {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (def: Record<string, unknown>) => {
			tools[def.name as string] = def; // FULL capture (incl. promptSnippet)
		},
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		getThinkingLevel: () => "off",
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		events: { emit() {} },
		ui: {},
	};
	extension(mockPi as never);
	return tools;
}

test("power-tool tools are stealth-trimmed: no promptSnippet/guidelines", () => {
	const tools = captureInspectTools();
	const expected = ["browser", "inspect_agent", "inspect_context", "inspect_extensions", "inspect_hooks", "inspect_pathology", "inspect_tui", "webui"];
	expect(Object.keys(tools).sort()).toEqual(expected.sort());

	for (const [name, tool] of Object.entries(tools)) {
		expect(typeof tool.description).toBe("string");
		expect(String(tool.description).length).toBeGreaterThan(0);
		expect(tool.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
		expect(tool.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
	}
});
