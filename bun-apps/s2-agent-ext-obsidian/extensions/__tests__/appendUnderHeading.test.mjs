/**
 * A0.8 — appendUnderHeading tests.
 *   bun test extensions/__tests__/appendUnderHeading.test.mjs
 *
 * Validates: insert under same-level heading; deeper heading ends section;
 * missing heading → new section at end; idempotency of repeated appends.
 *
 * NOTE: appendUnderHeading reads/writes the filesystem directly; each test
 * builds its own note content via a fresh fixture path.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { appendUnderHeading } from "../obsidian.ts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => { vault = await makeFixture({}); });
afterAll(async () => { await rmFixture(vault); });

async function writeNote(rel, content) {
	const abs = join(vault, rel);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content, "utf8");
}
async function readNote(rel) {
	return readFile(join(vault, rel), "utf8");
}

describe("appendUnderHeading — existing heading", () => {
	it("inserts content under a matching ## heading", async () => {
		await writeNote("t/under.md", "# Title\n\n## Log\n\n- first\n\n## Other\n\nbody\n");
		await appendUnderHeading(vault, "t/under.md", "Log", "- second");
		const after = await readNote("t/under.md");
		expect(after).toContain("- second");
		// inserted before the next heading
		const logIdx = after.indexOf("## Log");
		const secondIdx = after.indexOf("- second");
		const otherIdx = after.indexOf("## Other");
		expect(logIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(otherIdx);
	});

	it("matches any heading level (# Foo, ## Foo, ### Foo)", async () => {
		await writeNote("t/level.md", "### Section\n\nexisting\n");
		await appendUnderHeading(vault, "t/level.md", "Section", "appended");
		const after = await readNote("t/level.md");
		expect(after).toContain("appended");
	});

	it("a deeper heading is a subsection (does not end the section)", async () => {
		// Insert under ## Log (level 2). ### Sub (level 3) is DEEPER → part of Log's
		// section, so it does NOT end it. Content goes after ### Sub's body,
		// before ## Other (same level 2, which DOES end the section).
		await writeNote("t/boundary.md", "## Log\n\n- a\n\n### Sub\n\nsubbody\n\n## Other\n\nother\n");
		await appendUnderHeading(vault, "t/boundary.md", "Log", "- new");
		const after = await readNote("t/boundary.md");
		const newIdx = after.indexOf("- new");
		const subIdx = after.indexOf("### Sub");
		const otherIdx = after.indexOf("## Other");
		expect(subIdx).toBeLessThan(newIdx); // Sub comes before insertion
		expect(newIdx).toBeLessThan(otherIdx); // insertion before next same-level heading
	});
});

// Tag-MOC sections are conventionally headed `## #tag`, but the distill/garden
// subagent passes the heading sometimes as `#tag` and sometimes as `tag`. The
// match must be robust to that leading-'#' variance, else it creates duplicate
// sections at end-of-file (the real-world Tags/Index.md duplicate-MOC bug).
describe("appendUnderHeading — leading '#' normalization (tag-MOC)", () => {
	it("heading 'tag' matches existing '## #tag' (no duplicate created)", async () => {
		await writeNote("t/moc1.md", "# MOC\n\n## #architecture-pattern\n\n- [[First]]\n");
		const res = await appendUnderHeading(vault, "t/moc1.md", "architecture-pattern", "- [[Second]]");
		expect(res.insertedAt).toBe("heading");
		const after = await readNote("t/moc1.md");
		// appended into the existing section, not a new one
		expect(after).toContain("- [[Second]]");
		const headings = [...after.matchAll(/^## .+$/gm)].map((m) => m[0]);
		expect(headings.filter((h) => h === "## #architecture-pattern").length).toBe(1);
		expect(headings).not.toContain("## architecture-pattern");
	});

	it("heading '#tag' matches existing '## #tag'", async () => {
		await writeNote("t/moc2.md", "# MOC\n\n## #obsidian\n\n- [[A]]\n");
		const res = await appendUnderHeading(vault, "t/moc2.md", "#obsidian", "- [[B]]");
		expect(res.insertedAt).toBe("heading");
		const after = await readNote("t/moc2.md");
		expect(after).toContain("- [[B]]");
		const headings = [...after.matchAll(/^## .+$/gm)].map((m) => m[0]);
		expect(headings.filter((h) => h === "## #obsidian").length).toBe(1);
	});

	it("heading '#tag' also matches a bare '## tag' section", async () => {
		await writeNote("t/moc3.md", "# MOC\n\n## design\n\n- [[X]]\n");
		const res = await appendUnderHeading(vault, "t/moc3.md", "#design", "- [[Y]]");
		expect(res.insertedAt).toBe("heading");
		const after = await readNote("t/moc3.md");
		expect(after).toContain("- [[Y]]");
	});
});

describe("appendUnderHeading — missing heading", () => {
	it("appends a new ## section at the end when heading absent", async () => {
		await writeNote("t/missing.md", "# Title\n\nbody line\n");
		await appendUnderHeading(vault, "t/missing.md", "Changelog", "- entry");
		const after = await readNote("t/missing.md");
		expect(after).toContain("## Changelog");
		expect(after).toContain("- entry");
		// new section appears after original body
		expect(after.indexOf("body line")).toBeLessThan(after.indexOf("## Changelog"));
	});

	it("creates the note if it does not exist", async () => {
		const rel = "t/newnote.md";
		// ensure absent
		await rmFixture(join(vault, rel)).catch(() => {});
		const res = await appendUnderHeading(vault, rel, "Notes", "first entry");
		expect(res.created).toBe(true);
		const after = await readNote(rel);
		expect(after).toContain("## Notes");
		expect(after).toContain("first entry");
	});
});

describe("appendUnderHeading — idempotency / repetition", () => {
	it("repeated appends accumulate under the same heading", async () => {
		await writeNote("t/repeat.md", "# T\n\n## Log\n\n- one\n");
		await appendUnderHeading(vault, "t/repeat.md", "Log", "- two");
		await appendUnderHeading(vault, "t/repeat.md", "Log", "- three");
		const after = await readNote("t/repeat.md");
		expect(after).toContain("- one");
		expect(after).toContain("- two");
		expect(after).toContain("- three");
		// all three log lines appear in order within the section
		const one = after.indexOf("- one");
		const two = after.indexOf("- two");
		const three = after.indexOf("- three");
		expect(one).toBeLessThan(two);
		expect(two).toBeLessThan(three);
	});
});

describe("appendUnderHeading — return shape", () => {
	it("returns {created, insertedAt} indicating where content went", async () => {
		await writeNote("t/shape.md", "# T\n\n## Log\n\nx\n");
		const under = await appendUnderHeading(vault, "t/shape.md", "Log", "y");
		expect(under.insertedAt).toBe("heading");
		expect(under.created).toBe(false);

		await writeNote("t/shape2.md", "# T\n\nbody\n");
		const end = await appendUnderHeading(vault, "t/shape2.md", "New", "z");
		expect(end.insertedAt).toBe("end");
	});
});
