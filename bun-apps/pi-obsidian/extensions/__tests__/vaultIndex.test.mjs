/**
 * B1.1 — VaultIndex tests.
 *   bun test extensions/__tests__/vaultIndex.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { buildIndex, getIndex, resolveWikiLink, dropIndex, reindexFile, backlinkPaths, tagPaths } from "../obsidian.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"hub.md": "---\ntags: [alpha]\ncreated: 2026-01-01\n---\n\n# Hub\n\nlinks [[Spoke]] and [[Other]].\n",
		"spoke.md": "# Spoke\n\ntags #beta inline. Back to [[hub]].\n",
		"orphan.md": "# Orphan\n\nno links here.\n",
		"broken.md": "refers to [[NoSuch]] note.\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

describe("VaultIndex — build (B1.1)", () => {
	it("indexes all notes", async () => {
		dropIndex(vault);
		const idx = await getIndex(vault);
		expect(idx.notes.size).toBe(4);
		expect([...idx.notes.keys()].sort()).toEqual(["broken.md", "hub.md", "orphan.md", "spoke.md"]);
	});

	it("extracts title (first H1, lowercased)", async () => {
		const idx = await getIndex(vault);
		expect(idx.byTitle.get("hub")).toBe("hub.md");
		expect(idx.byTitle.get("spoke")).toBe("spoke.md");
	});

	it("collects tags from frontmatter and inline #tag", async () => {
		const idx = await getIndex(vault);
		expect([...idx.byTag.get("alpha")]).toEqual(["hub.md"]);
		expect(idx.byTag.get("beta")).toContain("spoke.md");
	});

	it("captures created date", async () => {
		const idx = await getIndex(vault);
		expect(idx.notes.get("hub.md")?.created).toBe("2026-01-01");
	});

	it("builds reverse adjacency (backlinks via index)", async () => {
		const idx = await getIndex(vault);
		// hub links [[Spoke]] → reverseAdjacency['spoke.md'] includes hub.md
		const backToSpoke = idx.reverseAdjacency.get("spoke.md");
		expect(backToSpoke).toContain("hub.md");
		// spoke links [[hub]] → reverseAdjacency['hub.md'] includes spoke.md
		const backToHub = idx.reverseAdjacency.get("hub.md");
		expect(backToHub).toContain("spoke.md");
	});
});

describe("VaultIndex — resolveWikiLink", () => {
	it("resolves by exact title", async () => {
		const idx = await getIndex(vault);
		expect(resolveWikiLink(idx, "Hub")).toBe("hub.md");
		expect(resolveWikiLink(idx, "hub")).toBe("hub.md");
	});

	it("resolves path-qualified by basename fallback", async () => {
		const idx = await getIndex(vault);
		expect(resolveWikiLink(idx, "folder/Hub")).toBe("hub.md");
	});

	it("returns undefined for unknown target", async () => {
		const idx = await getIndex(vault);
		expect(resolveWikiLink(idx, "NoSuch")).toBeUndefined();
	});
});

describe("VaultIndex — incremental reindex (B1.1)", () => {
	it("reindexFile picks up new content after a write", async () => {
		const idx = await getIndex(vault);
		const before = idx.notes.get("orphan.md")?.title;
		expect(before).toBe("orphan");
		await writeFile(join(vault, "orphan.md"), "# Renamed\n\n#tag2\n", "utf8");
		await reindexFile(vault, "orphan.md");
		const after = idx.notes.get("orphan.md");
		expect(after?.title).toBe("renamed");
		expect(idx.byTag.get("tag2")).toContain("orphan.md");
		// new title resolves
		expect(idx.byTitle.get("renamed")).toBe("orphan.md");
		// path basename still resolves as an alias (byTitle now keys title + path + basename)
		expect(idx.byTitle.get("orphan")).toBe("orphan.md");
	});
});

describe("VaultIndex — O(1) lookups (B1.2)", () => {
	it("backlinkPaths returns inbound sources via index", async () => {
		const idx = await getIndex(vault);
		expect([...backlinkPaths(idx, "hub")]).toContain("spoke.md");
		expect([...backlinkPaths(idx, "Spoke")]).toContain("hub.md");
	});

	it("tagPaths returns notes carrying a tag", async () => {
		const idx = await getIndex(vault);
		expect([...tagPaths(idx, "alpha")]).toEqual(["hub.md"]);
		expect([...tagPaths(idx, "#beta")]).toContain("spoke.md");
		expect([...tagPaths(idx, "nope")]).toEqual([]);
	});

	it("backlink lookup on 1000-note synthetic vault is fast (<20ms)", async () => {
		const big = await makeFixture(Object.fromEntries(
			Array.from({ length: 1000 }, (_, i) => [`n${i}.md`, `# N${i}\n\nlinks [[n0]] and tag #t.\n`]),
		));
		try {
			dropIndex(big);
			const idx = await getIndex(big); // build is O(n); not measured
			const t = performance.now();
			const set = backlinkPaths(idx, "n0");
			const dt = performance.now() - t; // only the O(1) lookup
			expect(set.size).toBe(1000); // all 1000 including self-link n0
			expect(dt).toBeLessThan(20);
		} finally {
			dropIndex(big);
			await rmFixture(big);
		}
	});
});
