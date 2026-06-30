/**
 * B3.4 — deleteNote link cleanup.
 *   bun test extensions/__tests__/deleteCleanup.test.mjs
 *
 * Regression: cleanupLinks must strip [[filename]] inbound links even when the
 * note's H1 title differs from its filename. Wiki-links target the FILENAME, not
 * the title; an earlier version keyed the backlink lookup on meta.title and so
 * found zero links whenever title !== filename (e.g. "# Old Draft" in OldDraft.md).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { deleteNote, dropIndex } from "../obsidian.ts";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"OldDraft.md": "# Old Draft\n\nstale note whose title differs from filename.\n",
		"Ref.md": "# Ref\n\nSee [[OldDraft]] for context.\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

const exists = (p) => access(p).then(() => true, () => false);

describe("deleteNote link cleanup (B3.4)", () => {
	it("removes [[filename]] inbound links when title !== filename", async () => {
		const r = await deleteNote(vault, "OldDraft", { cleanupLinks: true });
		expect(r.deleted).toBe(true);
		expect(r.linksCleaned).toContain("Ref.md");
		expect(await exists(join(vault, "OldDraft.md"))).toBe(false);
		const ref = await readFile(join(vault, "Ref.md"), "utf8");
		expect(ref).not.toContain("[[OldDraft]]");
	});

	it("leaves inbound links when cleanupLinks is false", async () => {
		// re-create the fixture pair for this isolated case
		const v = await makeFixture({
			"Keep.md": "# Keep\n\nsurvives.\n",
			"Linker.md": "# Linker\n\npoints at [[Keep]].\n",
		});
		try {
			const r = await deleteNote(v, "Keep", { cleanupLinks: false });
			expect(r.deleted).toBe(true);
			expect(r.linksCleaned).toEqual([]);
			const linker = await readFile(join(v, "Linker.md"), "utf8");
			expect(linker).toContain("[[Keep]]");
		} finally {
			dropIndex(v);
			await rmFixture(v);
		}
	});
});
