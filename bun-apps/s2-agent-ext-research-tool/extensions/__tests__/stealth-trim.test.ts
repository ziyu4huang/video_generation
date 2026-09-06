/**
 * stealth-trim.test.ts — regression guard: the research-tool tools must stay
 * free of per-turn `promptSnippet`/`promptGuidelines`. The rich `description`
 * already routes the model.
 *
 * Captures the registered tools via the factory + a mock pi (Proxy swallows
 * `pi.registerCommand` etc.; only `registerTool` is captured).
 */
import { test, expect } from "bun:test";
import extension from "../research-tool.ts";

function captureTools(): Record<string, Record<string, unknown>> {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = new Proxy(
		{
			registerTool: (t: Record<string, unknown>) => {
				tools[t.name as string] = t;
			},
		},
		{
			get(target, prop) {
				return prop in target ? Reflect.get(target, prop) : () => {};
			},
		},
	);
	extension(mockPi as never);
	return tools;
}

test("research-tool tools are stealth-trimmed: no promptSnippet/guidelines", () => {
	const tools = captureTools();
	expect(Object.keys(tools).length).toBe(7);

	for (const [name, tool] of Object.entries(tools)) {
		expect(typeof tool.description).toBe("string");
		expect(String(tool.description).length).toBeGreaterThan(0);
		expect(tool.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
		expect(tool.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
	}
});
