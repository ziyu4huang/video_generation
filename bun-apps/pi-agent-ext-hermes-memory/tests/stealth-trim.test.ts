/**
 * stealth-trim.test.ts — regression guard: hermes-memory's tools (memory,
 * memory_search, session_search ×2, skill_*) must stay free of per-turn
 * `promptSnippet`/`promptGuidelines`. Rich `description`s already route.
 *
 * The full factory is heavy (constructs MemoryStore/SkillStore/SqliteBackend),
 * so we capture via each tool's `registerXxxTool(pi, deps)` directly. Registration
 * only BUILDS the tool object (deps are consumed inside `execute`, never at
 * registration), so fake deps suffice.
 */
import { test, expect } from "bun:test";
import { registerMemorySearchTool } from "../src/tools/memory-search-tool.ts";
import { registerSessionSearchTool } from "../src/tools/session-search-tool.ts";
import { registerSkillTool } from "../src/tools/skill-tool.ts";
import { registerMemoryTool } from "../src/tools/memory-tool.ts";

function captureAll(): Record<string, Record<string, unknown>> {
	const tools: Record<string, Record<string, unknown>> = {};
	const pi = {
		registerTool: (t: Record<string, unknown>) => {
			tools[t.name as string] = t;
		},
	};
	const fake = {} as never;
	registerMemorySearchTool(pi as never, fake);
	// session-search-tool registers a different tool per variant branch.
	registerSessionSearchTool(pi as never, fake, { variant: "legacy" } as never);
	registerSessionSearchTool(pi as never, fake, { variant: "anchors" } as never);
	registerSkillTool(pi as never, fake);
	registerMemoryTool(pi as never, fake, null);
	return tools;
}

test("hermes-memory tools are stealth-trimmed: no promptSnippet/guidelines", () => {
	const tools = captureAll();
	expect(Object.keys(tools).length).toBeGreaterThanOrEqual(5);

	for (const [name, tool] of Object.entries(tools)) {
		expect(typeof tool.description).toBe("string");
		expect(String(tool.description).length).toBeGreaterThan(0);
		expect(tool.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
		expect(tool.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
	}
});
