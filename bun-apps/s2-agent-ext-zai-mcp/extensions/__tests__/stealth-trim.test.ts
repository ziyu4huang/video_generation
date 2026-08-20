/**
 * stealth-trim.test.ts — regression guard: zai-mcp registers MCP-server tools
 * DYNAMICALLY at connect time, so the static factory-capture pattern doesn't
 * apply. Instead we unit-test the exported `registerServerTools` helper
 * directly with a mock pi + fake MCP tools, asserting each registered tool
 * carries a routing `description` but NO per-turn `promptSnippet`/`promptGuidelines`
 * (the generated snippet was `${name}: ${firstLine(desc)}` — fully redundant
 * with the description already passed through).
 */
import { test, expect } from "bun:test";
import { registerServerTools } from "../zai-mcp.ts";

function captureFromServerTools(): Record<string, Record<string, unknown>> {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (t: Record<string, unknown>) => {
			tools[t.name as string] = t;
		},
	};
	const managed = {
		serverName: "demo",
		client: {},
		close: async () => {},
	};
	const mcpTools = [
		{ name: "echo", description: "Echo back the input.", inputSchema: { type: "object", properties: {} } },
		{ name: "noDesc", inputSchema: { type: "object", properties: {} } },
	];
	registerServerTools(mockPi as never, managed as never, mcpTools as never);
	return tools;
}

test("zai-mcp registered tools are stealth-trimmed: no promptSnippet/guidelines", () => {
	const tools = captureFromServerTools();
	expect(Object.keys(tools).sort()).toEqual(["zai_demo_echo", "zai_demo_noDesc"]);

	for (const [name, tool] of Object.entries(tools)) {
		expect(typeof tool.description).toBe("string");
		expect(String(tool.description).length).toBeGreaterThan(0);
		expect(tool.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
		expect(tool.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
	}
});
