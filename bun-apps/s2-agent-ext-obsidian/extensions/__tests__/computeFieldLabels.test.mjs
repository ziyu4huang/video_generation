/**
 * A0.4 — computeFieldLabels tests.
 *   bun test extensions/__tests__/computeFieldLabels.test.mjs
 *
 * Validates per-line classification: frontmatter block (incl. tags: line),
 * first H1 → title, body, inline #tag in body.
 */
import { describe, it, expect } from "bun:test";
import { computeFieldLabels } from "../obsidian.ts";

/** Helper: label a full note's lines, return array of sorted label arrays. */
function label(noteLines) {
	return computeFieldLabels(noteLines).map((s) => [...s].sort());
}

describe("computeFieldLabels — frontmatter", () => {
	it("classifies a properly terminated --- block as frontmatter", () => {
		const lines = ["---", "id: 1", "tags: [a, b]", "---", "# Title", "body"];
		const labels = label(lines);
		expect(labels[0]).toEqual(["frontmatter"]); // opening ---
		expect(labels[1]).toEqual(["frontmatter"]); // id: line
		expect(labels[2]).toEqual(["frontmatter", "tags"]); // tags: line → also tags
		expect(labels[3]).toEqual(["frontmatter"]); // closing ---
	});

	it("unterminated frontmatter (no closing ---) is NOT treated as frontmatter", () => {
		const lines = ["---", "id: 1", "tags: [a]", "", "# Title"];
		const labels = label(lines);
		// No closing fence → fmStart reset to -1 → none of these are frontmatter.
		// Line 0 "---" becomes body, line 4 "# Title" becomes title.
		expect(labels[0]).toEqual(["body"]);
		expect(labels[2]).toEqual(["body"]); // would-be tags: line is just body
		expect(labels[4]).toEqual(["title"]);
	});

	it("frontmatter must start at line 0", () => {
		const lines = ["# Title first", "---", "tags: [a]", "---"];
		const labels = label(lines);
		// --- at line 1 is not frontmatter (not first line); it's body
		expect(labels[1]).toEqual(["body"]);
		expect(labels[0]).toEqual(["title"]);
	});
});

describe("computeFieldLabels — title", () => {
	it("first H1 (# ...) becomes title", () => {
		const lines = ["body before", "# The Title", "## Subheading", "more body"];
		const labels = label(lines);
		expect(labels[1]).toEqual(["title"]);
		// ## Subheading is NOT title (only first H1)
		expect(labels[2]).toEqual(["body"]);
	});

	it("H1 requires non-whitespace after #", () => {
		// "#" alone or "# " with nothing shouldn't be title; "# X" should.
		const lines = ["#", "# ", "# Real"];
		const labels = label(lines);
		// Only "# Real" (line 2) qualifies per regex /^#\s+\S/
		expect(labels[2]).toEqual(["title"]);
	});

	it("no H1 → no title label anywhere", () => {
		const lines = ["just body", "## h2 not title"];
		const labels = label(lines);
		expect(labels.every((s) => !s.includes("title"))).toBe(true);
	});
});

describe("computeFieldLabels — body + inline tags", () => {
	it("body lines outside frontmatter/title are body", () => {
		const lines = ["---", "tags: [a]", "---", "# T", "plain body line"];
		const labels = label(lines);
		expect(labels[4]).toEqual(["body"]);
	});

	it("inline #tag in body adds tags label", () => {
		const lines = ["# Title", "this has #inline-tag here", "plain"];
		const labels = label(lines);
		expect(labels[1]).toEqual(["body", "tags"]);
		expect(labels[2]).toEqual(["body"]);
	});

	it("inline tag must be preceded by start or whitespace", () => {
		// "foo#bar" is not a tag (# not at start/whitespace boundary)
		const lines = ["foo#bar end"];
		const labels = label(lines);
		expect(labels[0]).toEqual(["body"]);
		// " #real" is a tag
		const lines2 = ["text #real"];
		expect(label(lines2)[0]).toEqual(["body", "tags"]);
	});
});
