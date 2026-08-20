/**
 * stealth-trim.test.ts — regression guard: the knowledge-card tools (zk_card,
 * zk_ask, zk_ingest, knowledge_query) must stay free of per-turn
 * `promptSnippet`/`promptGuidelines`. The rich `description` already routes.
 *
 * Captures the 4 registered tools via the factory + a mock pi (Proxy swallows
 * `pi.registerCommand`/`pi.on` etc.; only `registerTool` is captured).
 */
import { test, expect } from "bun:test";
import piKnowledgeCardExtension from "../knowledge-card.ts";

function captureTools(): Record<string, Record<string, unknown>> {
	// knowledge-card's factory also reads `pi.events` (the workflow host-fn bus),
	// so the mock needs both `registerTool` and a stub `events` — matching the
	// pattern already used in __tests__/pi-knowledge-card.test.ts.
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (t: Record<string, unknown>) => {
			tools[t.name as string] = t;
		},
		on() {},
		events: { on() {}, emit() {} },
	};
	piKnowledgeCardExtension(mockPi as never);
	return tools;
}

test("knowledge-card tools are stealth-trimmed: no promptSnippet/guidelines", () => {
	const tools = captureTools();
	expect(Object.keys(tools).length).toBe(4);

	for (const [name, tool] of Object.entries(tools)) {
		expect(typeof tool.description).toBe("string");
		expect(String(tool.description).length).toBeGreaterThan(0);
		expect(tool.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
		expect(tool.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
	}
});
