/**
 * Near-duplicate detection for the memory store (wayfinder effort
 * 2026-07-30-self-reflection-to-fix-these-error ticket 02).
 *
 * The store's existing dup-check is EXACT-match only (stripped-content equality)
 * + the error-detector dedups on a normalised first-line key. Neither catches
 * NEAR-duplicates — the same lesson re-captured with different wording
 * (mupdf ×3, SurrealDB ×2-3 in the failure store). This module adds a
 * containment-based near-dup detector used as a write-time warning gate in
 * MemoryStore._addInner.
 *
 * Metric: containment of the NEW entry's filtered tokens in an existing entry's
 * filtered tokens (|new ∩ existing| / |new|) — "is most of what this new entry
 * says already said by an existing entry?". Jaccard over full text under-weights
 * long entries that share a core lesson but differ in surrounding prose; the
 * existing exact-dup check already handles the identical case. Tokens are
 * lowercased, split on non-word chars, with <4-char tokens + a stopword set +
 * pure numbers dropped, and bracketed category prefixes ([tool-quirk]…) stripped
 * (metadata, not content).
 */
import { test, expect, describe } from "bun:test";
import { findNearDuplicate, nearDupTokens, containment } from "../../src/store/near-dup.js";

describe("near-dup detection (findNearDuplicate)", () => {
	test("flags a realistic near-duplicate (same lesson, different wording — the mupdf ×3 class)", () => {
		const existing = [
			"mupdf-js@2.0.1 is a DEPRECATED STUB. Use mupdf@1.28.0. API: Document.openDocument(path), then page.toStructuredText().asText() for text. There is no page.toText or page.getText.",
			"tests should be hermetic — clear harness env vars in beforeEach.",
		];
		// Same lesson, re-worded (how the agent re-captures a known gotcha):
		const content =
			"mupdf npm API: call Document.openDocument(Buffer) not Document.open. Extract page text via page.toStructuredText().asText() — there is no page.toText. mupdf-js@2.0.1 is a deprecated stub; use mupdf@1.28.0.";
		const hit = findNearDuplicate(content, existing, 0.6);
		expect(hit).not.toBeNull();
		expect(hit!.index).toBe(0);
		expect(hit!.similarity).toBeGreaterThanOrEqual(0.6);
	});

	test("distinct lessons are NOT flagged", () => {
		const existing = [
			"SurrealDB nested IN-SELECT subqueries over edge tables are pathologically slow; use native graph traversal array::intersect.",
		];
		const content =
			"SDD plan briefs can contain type errors that implementers copy verbatim; reviewers must run tsc --noEmit.";
		expect(findNearDuplicate(content, existing, 0.6)).toBeNull();
	});

	test("identical content is a near-dup (similarity 1.0)", () => {
		const existing = ["the quick brown fox jumps over the lazy dog every morning"];
		const content = "the quick brown fox jumps over the lazy dog every morning";
		const hit = findNearDuplicate(content, existing, 0.6);
		expect(hit).not.toBeNull();
		expect(hit!.similarity).toBeCloseTo(1.0, 5);
	});

	test("threshold is respected (a partial overlap below threshold returns null)", () => {
		const existing = ["the quick brown fox jumps over the lazy dog every single morning"];
		// ~55% contained — below a 0.9 threshold.
		const content = "the quick brown fox jumps over the lazy dog";
		expect(findNearDuplicate(content, existing, 0.9)).toBeNull();
	});

	test("too-short content returns null (cannot judge)", () => {
		expect(findNearDuplicate("short", ["short short short short short"], 0.6)).toBeNull();
	});

	test("returns the BEST match when several existing entries partially overlap", () => {
		const existing = [
			"unrelated note about the weather today being sunny and warm",
			"mupdf openDocument toStructuredText asText page text extraction",
		];
		const content = "mupdf page text extraction uses openDocument then toStructuredText asText";
		const hit = findNearDuplicate(content, existing, 0.5);
		expect(hit).not.toBeNull();
		expect(hit!.index).toBe(1); // the mupdf one, not the weather one
	});
});

describe("near-dup primitives", () => {
	test("nearDupTokens strips bracketed prefixes + drops short/stop tokens", () => {
		const tokens = nearDupTokens("[tool-quirk] the mupdf Document.openDocument");
		expect(tokens.has("tool")).toBe(false); // bracketed prefix stripped
		expect(tokens.has("quirk")).toBe(false);
		expect(tokens.has("the")).toBe(false); // stopword
		expect(tokens.has("mupdf")).toBe(true);
		expect(tokens.has("document")).toBe(true); // lowercased
		expect(tokens.has("opendocument")).toBe(true);
	});

	test("containment is asymmetric (new-in-existing)", () => {
		const a = new Set(["mupdf", "page", "text"]);
		const b = new Set(["mupdf", "page", "text", "extra", "tokens"]);
		// a fully contained in b → 1.0; b only partly in a.
		expect(containment(a, b)).toBeCloseTo(1.0, 5);
		expect(containment(b, a)).toBeCloseTo(0.6, 5);
	});
});
