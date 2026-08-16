/**
 * stealth-trim.test.ts — regression guard: hermes-memory's tools (memory,
 * search ×2 (legacy/anchors variant configs), skill_*) must stay free of per-turn
 * `promptSnippet`/`promptGuidelines`. Rich `description`s already route.
 *
 * The full factory is heavy (constructs MemoryStore/SkillStore/SqliteBackend),
 * so we capture via each tool's `registerXxxTool(pi, deps)` directly. Registration
 * only BUILDS the tool object (deps are consumed inside `execute`, never at
 * registration), so fake deps suffice.
 */
import { test, expect } from "bun:test";
import { registerSearchTool } from "../src/tools/search-tool.ts";
import { registerSkillTool } from "../src/tools/skill-tool.ts";
import { registerMemoryTool } from "../src/tools/memory-tool.ts";

function captureAll(): Record<string, unknown>[] {
	const defs: Record<string, unknown>[] = [];
	const pi = {
		registerTool: (t: Record<string, unknown>) => {
			defs.push(t);
		},
	};
	const fake = {} as never;
	registerMemoryTool(pi as never, fake, null);
	// The unified search tool shares one `name` across variant configs; collect
	// registration defs in a list (not a name-keyed map) so each variant counts.
	registerSearchTool(pi as never, fake, fake, { variant: "legacy" } as never);
	registerSearchTool(pi as never, fake, fake, { variant: "anchors" } as never);
	registerSkillTool(pi as never, fake);
	return defs;
}

test("hermes-memory tools are stealth-trimmed: no promptSnippet/guidelines", () => {
	const defs = captureAll();
	expect(defs.length).toBeGreaterThanOrEqual(5);

	for (const tool of defs) {
		const name = String(tool.name);
		expect(typeof tool.description).toBe("string");
		expect(String(tool.description).length).toBeGreaterThan(0);
		expect(tool.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
		expect(tool.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
	}
});
