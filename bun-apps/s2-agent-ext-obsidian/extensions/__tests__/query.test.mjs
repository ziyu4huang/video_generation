/**
 * B4 — structured query (queryNotes) + search paths filter.
 *   bun test extensions/__tests__/query.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { queryNotes, searchVault, buildMatcher, dropIndex, getIndex } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"a1.md": "---\ncreated: 2026-01-01\ntags: [alpha, shared]\n---\n\n# A1\n\nmentions obsidian.\n",
		"a2.md": "---\ncreated: 2026-06-01\ntags: [alpha]\n---\n\n# A2\n\nmentions agent.\n",
		"b1.md": "---\ncreated: 2026-03-01\ntags: [beta, shared]\n---\n\n# B1\n\nmentions obsidian too.\n",
		"sub/c1.md": "---\ncreated: 2026-05-01\ntags: [gamma]\n---\n\n# C1\n\nmentions obsidian.\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

async function idx() { return getIndex(vault); }

describe("queryNotes — tags (B4.1/B4.2)", () => {
	it("tags AND semantics", async () => {
		const r = await queryNotes(vault, { tags: ["alpha", "shared"] });
		expect(r.map((x) => x.path).sort()).toEqual(["a1.md"]);
	});
	it("anyTags OR semantics", async () => {
		const r = await queryNotes(vault, { anyTags: ["beta", "gamma"] });
		expect(r.map((x) => x.path).sort()).toEqual(["b1.md", "sub/c1.md"]);
	});
	it("folder restriction", async () => {
		const r = await queryNotes(vault, { folder: "sub" });
		expect(r.map((x) => x.path)).toEqual(["sub/c1.md"]);
	});

	it("folder restriction is prefix-exact (no sibling-folder / prefixed-root over-match)", async () => {
		// Self-contained fixture: folder "sub" must match only sub/c1.md, NOT the
		// sibling folder sub2/ nor the root note "submarine.md" (both start with "sub").
		const v = await makeFixture({
			"sub/c1.md": "# C1\n",
			"sub2/d.md": "# D\n",
			"submarine.md": "# Sub\n",
		});
		try {
			const r = await queryNotes(v, { folder: "sub" });
			expect(r.map((x) => x.path)).toEqual(["sub/c1.md"]);
		} finally {
			dropIndex(v);
			await rmFixture(v);
		}
	});
	it("createdAfter", async () => {
		const r = await queryNotes(vault, { createdAfter: "2026-04-01" });
		expect(r.map((x) => x.path).sort()).toEqual(["a2.md", "sub/c1.md"]);
	});
	it("createdBefore", async () => {
		const r = await queryNotes(vault, { createdBefore: "2026-02-01" });
		expect(r.map((x) => x.path)).toEqual(["a1.md"]);
	});
	it("returns metadata, not body", async () => {
		const r = await queryNotes(vault, { tags: ["alpha"] });
		expect(r[0]).toHaveProperty("title");
		expect(r[0]).toHaveProperty("tags");
		expect(JSON.stringify(r)).not.toContain("mentions"); // body not included
	});
});

describe("search paths filter (B4.3)", () => {
	it("restricts search to the given path set", async () => {
		const built = buildMatcher("obsidian", "substring", false);
		const all = await searchVault(vault, { match: built.match, fields: null, folder: "", max: 100 });
		const restricted = await searchVault(vault, { match: built.match, fields: null, folder: "", max: 100, paths: ["a1.md"] });
		expect(restricted.every((m) => m.file === "a1.md")).toBe(true);
		expect(restricted.length).toBeLessThan(all.length);
	});
	it("empty paths set → no results", async () => {
		const built = buildMatcher("obsidian", "substring", false);
		const r = await searchVault(vault, { match: built.match, fields: null, folder: "", max: 100, paths: [] });
		expect(r).toEqual([]);
	});
});
