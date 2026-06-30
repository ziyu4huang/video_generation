/**
 * A0.6 — findBacklinks tests.
 *   bun test extensions/__tests__/findBacklinks.test.mjs
 *
 * Validates: exact match, basename fallback for [[folder/name]], alias
 * [[a|b]] stripped, heading ref [[a#section]] stripped, case-insensitive
 * default, .md tolerated, unknown → empty.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { findBacklinks } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		// Target note (no incoming links defined here; links live in sources)
		"Zettelkasten/target.md": "# Target\n\nThe destination.\n",
		"Zettelkasten/deep/nested.md": "# Nested\n\nanother target.\n",
		// Source notes with varied link forms
		"src/exact.md": "refers to [[target]] inline.\n",
		"src/pathqual.md": "uses [[Zettelkasten/target]] qualified.\n",
		"src/alias.md": "alias form [[target|My Display]].\n",
		"src/heading.md": "section ref [[target#Section Two]].\n",
		"src/multi.md": "two links: [[target]] and [[nested]] here.\n",
		"src/casevar.md": "Mixed case [[Target]] here.\n",
		"src/unrelated.md": "no relevant links [[other]] here.\n",
	});
});
afterAll(async () => { await rmFixture(vault); });

function filesOf(matches) { return matches.map((m) => m.file).sort(); }

describe("findBacklinks — matching", () => {
	it("exact [[target]] is found", async () => {
		const m = await findBacklinks(vault, "target", { max: 100 });
		expect(filesOf(m)).toContain("src/exact.md");
	});

	it("path-qualified [[Zettelkasten/target]] is found via exact full-path match", async () => {
		const m = await findBacklinks(vault, "Zettelkasten/target", { max: 100 });
		expect(filesOf(m)).toContain("src/pathqual.md");
	});

	it("basename fallback: query 'target' also finds [[Zettelkasten/target]]", async () => {
		// basename of the qualified link equals 'target'
		const m = await findBacklinks(vault, "target", { max: 100 });
		expect(filesOf(m)).toContain("src/pathqual.md");
	});

	it("alias [[target|My Display]] is stripped to target and found", async () => {
		const m = await findBacklinks(vault, "target", { max: 100 });
		expect(filesOf(m)).toContain("src/alias.md");
	});

	it("heading ref [[target#Section Two]] is stripped to target and found", async () => {
		const m = await findBacklinks(vault, "target", { max: 100 });
		expect(filesOf(m)).toContain("src/heading.md");
	});

	it(".md suffix on query is tolerated", async () => {
		const a = await findBacklinks(vault, "target", { max: 100 });
		const b = await findBacklinks(vault, "target.md", { max: 100 });
		expect(b.length).toBe(a.length);
	});
});

describe("findBacklinks — case sensitivity", () => {
	it("case-insensitive by default: [[Target]] matches query 'target'", async () => {
		const m = await findBacklinks(vault, "target", { max: 100 });
		expect(filesOf(m)).toContain("src/casevar.md");
	});

	it("case-sensitive: query 'target' does NOT match link 'Target'", async () => {
		const m = await findBacklinks(vault, "target", { caseSensitive: true, max: 100 });
		expect(filesOf(m)).not.toContain("src/casevar.md");
	});
});

describe("findBacklinks — edge cases", () => {
	it("unknown target returns empty", async () => {
		const m = await findBacklinks(vault, "NoSuchNote", { max: 100 });
		expect(m).toEqual([]);
	});

	it("returns file:line:text shape", async () => {
		const m = await findBacklinks(vault, "target", { max: 1 });
		expect(m.length).toBe(1);
		expect(m[0]).toHaveProperty("file");
		expect(m[0]).toHaveProperty("line");
		expect(m[0]).toHaveProperty("text");
		expect(typeof m[0].line).toBe("number");
	});

	it("respects max cap", async () => {
		const m = await findBacklinks(vault, "target", { max: 2 });
		expect(m.length).toBeLessThanOrEqual(2);
	});
});
