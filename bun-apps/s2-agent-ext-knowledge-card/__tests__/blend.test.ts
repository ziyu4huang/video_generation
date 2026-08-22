/**
 * Unit tests for the zk-ask RAG task prompt and its tool allowlist, post
 * vault-mind retirement (context-lifecycle ticket 02, D2, 2026-08-22): the
 * semantic blend modes (`three-way` / `semantic-lexical`) and their score/
 * tool-resolution helpers were deleted with the vault-mind service. What
 * remains to pin: the prompt is lexical+graph only and never references the
 * removed `semantic_search` action.
 */
import { test, expect, describe } from "bun:test";
import { buildRagTask, RAG_TOOLS } from "../extensions/knowledge-card.ts";

describe("buildRagTask — post vault-mind retirement", () => {
	test("lexical 3-strategy seed retrieval, no semantic strategy", () => {
		const task = buildRagTask("q", 2, 8, false, false, 5, 2000, false, undefined);
		expect(task).toContain("run all 3 strategies");
		expect(task).toContain("0.7 × search_score");
		expect(task).toContain("0.3 × link_count");
	});

	test("never references the removed semantic_search action or vault-mind", () => {
		const task = buildRagTask("q", 2, 8, false, true, 5, 2000, false, "Zettelkasten");
		expect(task).not.toContain("semantic_search");
		expect(task).not.toContain("vault-mind");
		expect(task).not.toContain("semantic");
	});

	test("graph expansion step is always present", () => {
		const task = buildRagTask("q", 2, 8, false, false, 5, 2000, false, undefined);
		expect(task).toContain("## Step 2: Graph expansion");
	});

	test("retrieve-only has no modes provenance tag (modes died with the blends)", () => {
		const task = buildRagTask("q", 2, 8, false, true, 5, 2000, false, undefined);
		expect(task).not.toContain("[modes:");
	});
});

describe("RAG_TOOLS — allowlist", () => {
	test("carries the obsidian fat tool + help only", () => {
		expect(RAG_TOOLS).toEqual(["obsidian", "obsidian_help"]);
	});
});
