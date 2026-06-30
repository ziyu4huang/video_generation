/**
 * A0.7 — findTagNotes tests.
 *   bun test extensions/__tests__/findTagNotes.test.mjs
 *
 * Validates: frontmatter flow tags:[a,b], block-YAML tags, inline #tag,
 * case-insensitive default, case-sensitive mode, unknown tag → empty.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { findTagNotes } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		// Flow-style frontmatter tags
		"a/flow.md": "---\ntags: [alpha, beta]\n---\n\n# Flow\n\nbody\n",
		// Block-style frontmatter tags (YAML block list)
		"a/block.md": "---\ntags:\n  - gamma\n  - delta\n---\n\n# Block\n\nbody\n",
		// Inline #tag in body (no frontmatter tags)
		"a/inline.md": "# Inline\n\nthis has #alpha and #delta inline.\n",
		// Mixed: frontmatter + inline
		"a/mixed.md": "---\ntags: [alpha]\n---\n\n# Mixed\n\nbody with #gamma inline.\n",
		// Decoy: word that looks like a tag but isn't
		"a/decoy.md": "# Decoy\n\nfoo#alpha not a real tag (no boundary).\n",
	});
});
afterAll(async () => { await rmFixture(vault); });

function filesOf(matches) { return matches.map((m) => m.file).sort(); }

describe("findTagNotes — frontmatter", () => {
	it("matches flow-style tags: [alpha, beta]", async () => {
		const m = await findTagNotes(vault, "#alpha", { max: 100 });
		expect(filesOf(m)).toContain("a/flow.md");
	});

	// KNOWN GAP (C1.2): current regex frontmatter parser only handles flow form
	// `tags: [a,b]` on one line. Block YAML (`tags:\n  - a`) is missed.
	// Will be enforced once findTagNotes routes through parseFrontmatter (C1.2).
	it("matches block-style YAML tags (block list) — C1.2", async () => {
		const m = await findTagNotes(vault, "#gamma", { max: 100 });
		expect(filesOf(m)).toContain("a/block.md");
	});

	it("matches second entry in flow array", async () => {
		const m = await findTagNotes(vault, "#beta", { max: 100 });
		expect(filesOf(m)).toContain("a/flow.md");
	});
});

describe("findTagNotes — inline body tags", () => {
	it("matches inline #alpha in body", async () => {
		const m = await findTagNotes(vault, "#alpha", { max: 100 });
		expect(filesOf(m)).toContain("a/inline.md");
	});

	it("does not match a token without word boundary (foo#alpha)", async () => {
		// decoy.md has 'foo#alpha' — # not preceded by start/whitespace → not a tag
		const m = await findTagNotes(vault, "#alpha", { max: 100 });
		expect(filesOf(m)).not.toContain("a/decoy.md");
	});
});

describe("findTagNotes — case sensitivity", () => {
	it("case-insensitive by default", async () => {
		const lower = await findTagNotes(vault, "#alpha", { max: 100 });
		const upper = await findTagNotes(vault, "#ALPHA", { max: 100 });
		expect(upper.length).toBe(lower.length);
	});

	it("case-sensitive: #ALPHA does not match tag 'alpha'", async () => {
		const m = await findTagNotes(vault, "#ALPHA", { caseSensitive: true, max: 100 });
		// all tags are lowercase 'alpha' → no match
		expect(m).toEqual([]);
	});
});

describe("findTagNotes — edge cases", () => {
	it("unknown tag returns empty", async () => {
		const m = await findTagNotes(vault, "#nonexistent", { max: 100 });
		expect(m).toEqual([]);
	});

	it("leading # on query is optional (normalized)", async () => {
		const withHash = await findTagNotes(vault, "#alpha", { max: 100 });
		const noHash = await findTagNotes(vault, "alpha", { max: 100 });
		expect(noHash.length).toBe(withHash.length);
	});

	it("respects max cap", async () => {
		const m = await findTagNotes(vault, "#alpha", { max: 1 });
		expect(m.length).toBeLessThanOrEqual(1);
	});
});
