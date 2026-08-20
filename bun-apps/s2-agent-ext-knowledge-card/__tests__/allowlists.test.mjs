/**
 * Cross-package CONTRACT GUARD for the per-action tool allowlists.
 *
 * pi-knowledge-card spawns subagents that load obsidian tools by name. Every
 * allowlist entry prefixed `obsidian_` MUST name a tool that pi-obsidian
 * actually registers — otherwise the subagent loads, the tool is silently
 * absent, and the prompt instructs an action the agent cannot perform (a
 * silent break with no error). Non-prefixed entries (e.g. `read`, a pi
 * built-in) are out of scope here.
 *
 * The target set is computed DYNAMICALLY by loading the real pi-obsidian
 * extension (helpers/contract.mjs), so a rename/removal there fails this test
 * without any hand-maintained list to drift.
 *
 *   bun test __tests__/allowlists.test.mjs
 */
import { describe, it, expect } from "bun:test";
import { collectObsidianTools } from "./helpers/contract.mjs";
import {
	DISTILL_TOOLS,
	ADD_TOOLS,
	FIND_TOOLS,
	UPDATE_TOOLS,
	REMOVE_TOOLS,
	CHECK_TOOLS,
	RAG_TOOLS,
} from "../extensions/knowledge-card.ts";

const LISTS = {
	DISTILL_TOOLS,
	ADD_TOOLS,
	FIND_TOOLS,
	UPDATE_TOOLS,
	REMOVE_TOOLS,
	CHECK_TOOLS,
	RAG_TOOLS,
};

describe("allowlists — structure", () => {
	for (const [name, list] of Object.entries(LISTS)) {
		it(`${name} is a non-empty string[] with no duplicates`, () => {
			expect(Array.isArray(list)).toBe(true);
			expect(list.length).toBeGreaterThan(0);
			for (const entry of list) expect(typeof entry).toBe("string");
			expect(new Set(list).size).toBe(list.length);
		});
	}
});

describe("allowlists — obsidian_* entries resolve in pi-obsidian (contract guard)", () => {
	// Collect once (async); each test awaits the shared promise.
	let obsidianTools;
	const ready = collectObsidianTools().then((s) => {
		obsidianTools = s;
	});

	for (const [name, list] of Object.entries(LISTS)) {
		it(`every obsidian_* entry in ${name} is registered by pi-obsidian`, async () => {
			await ready;
			const obsidianEntries = list.filter((t) => t.startsWith("obsidian_"));
			expect(obsidianEntries.length).toBeGreaterThan(0);
			for (const t of obsidianEntries) {
				if (!obsidianTools.has(t)) {
					throw new Error(
						`${name} references "${t}" but pi-obsidian registers no such tool. ` +
							`Registered: ${[...obsidianTools].sort().join(", ")}`,
					);
				}
			}
		});
	}
});
