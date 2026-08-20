/**
 * B3.1 / B3.2 / B3.4 — move + auto link-rewrite, delete + link cleanup.
 *   bun test extensions/__tests__/structuredEditing.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { moveNote, deleteNote, getIndex, dropIndex } from "../obsidian.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"target.md": "# Target\n\nthe moved note.\n",
		"src1.md": "# Src1\n\nlinks [[Target]] bare.\n",
		"src2.md": "# Src2\n\nalias [[Target|Display]] and section [[Target#Sec]].\n",
		"unrelated.md": "# Other\n\nlinks [[Different]].\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

describe("moveNote (B3.1 + B3.2)", () => {
	it("moves the file and rewrites all inbound links", async () => {
		const r = await moveNote(vault, "target", "renamed/target2", { overwrite: true });
		expect(r.moved).toBe(true);
		expect(r.linksRewritten.sort()).toEqual(["src1.md", "src2.md"]);
		// old file gone
		await expect(readFile(join(vault, "target.md"))).rejects.toThrow();
		// new file present
		expect(await readFile(join(vault, "renamed/target2.md"), "utf8")).toContain("Target");
		// links updated
		const s1 = await readFile(join(vault, "src1.md"), "utf8");
		const s2 = await readFile(join(vault, "src2.md"), "utf8");
		expect(s1).not.toContain("[[Target]]");
		expect(s1.toLowerCase()).toContain("target2");
		// alias + section preserved
		expect(s2).toContain("|Display");
		expect(s2).toContain("#Sec");
		// unrelated untouched
		const u = await readFile(join(vault, "unrelated.md"), "utf8");
		expect(u).toContain("[[Different]]");
	});

	it("index reflects new location after move", async () => {
		dropIndex(vault);
		const idx = await getIndex(vault);
		expect(idx.byTitle.get("target")).toBe("renamed/target2.md");
	});
});

describe("deleteNote (B3.4)", () => {
	it("deletes the file and strips inbound links", async () => {
		// reset fixture
		await makeFixture({
			"victim.md": "# Victim\n\ndelete me.\n",
			"ref.md": "# Ref\n\npoints to [[Victim]] here.\n",
		}).then((v) => { vault = v; });
		const r = await deleteNote(vault, "victim");
		expect(r.deleted).toBe(true);
		expect(r.linksCleaned).toContain("ref.md");
		await expect(readFile(join(vault, "victim.md"))).rejects.toThrow();
		const ref = await readFile(join(vault, "ref.md"), "utf8");
		expect(ref).not.toContain("[[Victim]]");
	});
});
