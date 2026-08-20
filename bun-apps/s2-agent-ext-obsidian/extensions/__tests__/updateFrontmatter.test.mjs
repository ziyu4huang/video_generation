/**
 * B3.5 — updateFrontmatter tests.
 *   bun test extensions/__tests__/updateFrontmatter.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { updateFrontmatter, dropIndex } from "../obsidian.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"note.md": "---\nid: 1\ntags: [alpha]\n---\n\n# Title\n\nbody line untouched.\n",
		"nofm.md": "# NoFM\n\nno frontmatter here.\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

describe("updateFrontmatter (B3.5)", () => {
	it("adds a new key without touching body", async () => {
		const r = await updateFrontmatter(vault, "note", { created: "2026-06-26" });
		expect(r.updated).toContain("created");
		const after = await readFile(join(vault, "note.md"), "utf8");
		expect(after).toContain("created: 2026-06-26");
		expect(after).toContain("body line untouched.");
	});

	it("tags are unioned (not overwritten)", async () => {
		await updateFrontmatter(vault, "note", { tags: ["beta"] });
		const after = await readFile(join(vault, "note.md"), "utf8");
		expect(after).toContain("alpha");
		expect(after).toContain("beta");
	});

	it("does not duplicate existing tags", async () => {
		const before = await readFile(join(vault, "note.md"), "utf8");
		await updateFrontmatter(vault, "note", { tags: ["alpha"] });
		const after = await readFile(join(vault, "note.md"), "utf8");
		// alpha count stays the same
		const count = (after.match(/alpha/g) || []).length;
		expect(count).toBe((before.match(/alpha/g) || []).length);
	});

	it("overwrites a non-tag scalar key", async () => {
		await updateFrontmatter(vault, "note", { id: 999 });
		const after = await readFile(join(vault, "note.md"), "utf8");
		expect(after).toContain("id: 999");
		expect(after).not.toContain("id: 1\n");
	});

	it("adds frontmatter to a note that had none", async () => {
		await updateFrontmatter(vault, "nofm", { tags: ["new"] });
		const after = await readFile(join(vault, "nofm.md"), "utf8");
		expect(after.startsWith("---")).toBe(true);
		expect(after).toContain("# NoFM");
	});
});
