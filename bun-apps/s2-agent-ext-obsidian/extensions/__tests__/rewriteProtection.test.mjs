/**
 * Phase 1 / WS-A3 + D2 — wiki-link rewrite protection.
 * move/delete rewrites inbound [[links]] across the vault. The rewrite must NOT
 * touch [[..]] inside the YAML frontmatter block, fenced code blocks, or inline
 * `code` spans (it would corrupt YAML / break code). Embeds, section refs, and
 * aliases must round-trip correctly.
 *
 *   bun test extensions/__tests__/rewriteProtection.test.mjs
 */
import { describe, it, expect } from "bun:test";
import { rewriteLinksProtected, LINK_KEEP, LINK_DELETE } from "../obsidian.ts";

/** Rewriter that turns any [[old...]] token into [[NEW]] (for protection tests). */
const rewriteOldToNew = (raw) => {
	const target = raw.replace(/\|.*/, "").replace(/#.*/, "").replace(/\.md$/i, "").trim();
	if (target.toLowerCase() === "old") return "NEW";
	return LINK_KEEP;
};

describe("WS-A3 — rewrite skips protected regions", () => {
	it("does NOT rewrite inside fenced code blocks (```)", () => {
		const content = "Text [[old]] here.\n\n```\nconst x = [[old]]; // not a link\n```\n\nAfter [[old]].\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		expect(out).toContain("const x = [[old]];"); // untouched
		expect(out).toContain("Text [[NEW]] here.");
		expect(out).toContain("After [[NEW]].");
	});

	it("does NOT rewrite inside tilde-fenced blocks (~~~)", () => {
		const content = "~~~\n[[old]]\n~~~\n[[old]]\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		expect(out).toMatch(/~~~\n\[\[old\]\]\n~~~/);
		expect(out.endsWith("[[NEW]]\n")).toBe(true);
	});

	it("treats a same-char fence line inside the other fence as content (no early close)", () => {
		// Inside a ``` fence, a ~~~ line is literal; the ``` fence must still close
		// only on a later ``` line.
		const content = "```\n~~~\n[[old]]\n```\n[[old]]\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		// both [[old]] inside the fence stay; the trailing one rewrites
		expect(out).toBe("```\n~~~\n[[old]]\n```\n[[NEW]]\n");
	});

	it("does NOT rewrite inside inline `code` spans", () => {
		const content = "Use `[[old]]` macro, and [[old]] for real.\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		expect(out).toContain("`[[old]]`");
		expect(out).toContain("[[NEW]] for real");
	});

	it("does NOT rewrite inside the YAML frontmatter block", () => {
		const content =
			"---\ncreated: 2026-01-01\nrelated: [[old]]\ntags: [x]\n---\n\n# Title\n\nSee [[old]].\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		expect(out).toContain("related: [[old]]"); // frontmatter untouched
		expect(out).toContain("See [[NEW]].");
	});

	it("ignores a '---' separator that is NOT at the very top (not frontmatter)", () => {
		const content = "# Title\n\n---\n\n[[old]]\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		expect(out).toContain("[[NEW]]");
	});
});

describe("WS-A3 — token shapes round-trip correctly", () => {
	it("embeds ![[old]] follow the move (! prefix preserved)", () => {
		const content = "Embed: ![[old]]\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		expect(out).toBe("Embed: ![[NEW]]\n");
	});

	it("section refs [[old#section]] preserve the section", () => {
		const r = (raw) => (raw.replace(/#.*/, "").trim().toLowerCase() === "old" ? "NEW" + raw.slice(raw.indexOf("#")) : LINK_KEEP);
		// simpler: explicit rewriter
		const out = rewriteLinksProtected("[[old#Intro]]\n", (x) =>
			x.replace(/\.md$/i, "").replace(/^old/i, "NEW"),
		);
		expect(out).toBe("[[NEW#Intro]]\n");
	});

	it("aliases [[old|Display]] preserve the alias", () => {
		const out = rewriteLinksProtected("[[old|My Alias]]\n", (x) =>
			x.replace(/\.md$/i, "").replace(/^old/i, "NEW"),
		);
		expect(out).toBe("[[NEW|My Alias]]\n");
	});

	it("multi-pipe [[old|a|b]] preserves everything after the first pipe", () => {
		const out = rewriteLinksProtected("[[old|a|b]]\n", (x) =>
			x.replace(/\.md$/i, "").replace(/^old/i, "NEW"),
		);
		expect(out).toBe("[[NEW|a|b]]\n");
	});

	it("LINK_DELETE removes the whole token (used by delete cleanup)", () => {
		const content = "line with [[old]] inline\n";
		const out = rewriteLinksProtected(content, (raw) =>
			raw.replace(/\|.*/, "").replace(/#.*/, "").trim().toLowerCase() === "old"
				? LINK_DELETE
				: LINK_KEEP,
		);
		expect(out).toBe("line with  inline\n");
	});
});

describe("WS-A3 — regression: non-protected links still rewrite", () => {
	it("rewrites multiple links on one line, skipping an inline-code one between them", () => {
		const content = "[[old]] mid `[[old]]` end [[old]]\n";
		const out = rewriteLinksProtected(content, rewriteOldToNew);
		expect(out).toBe("[[NEW]] mid `[[old]]` end [[NEW]]\n");
	});
});
