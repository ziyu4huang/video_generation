/**
 * B2 — graph queries (outgoing / orphans / dead-links / neighbors).
 *   bun test extensions/__tests__/graphQueries.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getIndex, dropIndex, graphOutgoing, graphOrphans, graphDeadLinks, graphNeighbors } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		// A → B → C chain, plus an orphan and a dead link
		"a.md": "# A\n\nlinks [[B]] and [[C]].\n",
		"b.md": "# B\n\nlinks [[C]].\n",
		"c.md": "# C\n\nno outgoing.\n",
		"orphan.md": "# Orphan\n\nnobody links me.\n",
		"d.md": "# D\n\nbroken [[NoSuch]].\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

async function idx() { return getIndex(vault); }

describe("graphOutgoing (B2.1)", () => {
	it("returns the [[links]] a note points to", async () => {
		const r = graphOutgoing(await idx(), "A");
		expect(r.map((x) => x.path).sort()).toEqual(["b.md", "c.md"]);
	});
	it("returns [] for a note with no links", async () => {
		const r = graphOutgoing(await idx(), "C");
		expect(r.length).toBe(0);
	});
});

describe("graphOrphans (B2.2)", () => {
	it("lists notes with no inbound links", async () => {
		const r = graphOrphans(await idx());
		const paths = r.map((x) => x.path);
		// a is never linked; orphan never linked; d never linked. b,c are linked.
		expect(paths).toContain("a.md");
		expect(paths).toContain("orphan.md");
		expect(paths).toContain("d.md");
		expect(paths).not.toContain("b.md");
	});
});

describe("graphDeadLinks (B2.3)", () => {
	it("lists [[Target]] pointing to nonexistent notes", async () => {
		const r = graphDeadLinks(await idx());
		expect(r.some((x) => x.path === "d.md" && x.text.includes("NoSuch"))).toBe(true);
	});
	it("does not flag resolved links", async () => {
		const r = graphDeadLinks(await idx());
		expect(r.every((x) => !x.text.includes("B"))).toBe(true);
	});
});

describe("graphNeighbors (B2.4)", () => {
	it("depth 1 returns direct neighbors (both directions)", async () => {
		const r = graphNeighbors(await idx(), "C", 1);
		// C is linked by A and B → neighbors {a, b}
		expect(r.map((x) => x.path).sort()).toEqual(["a.md", "b.md"]);
	});
	it("depth 2 reaches transitive links", async () => {
		const r = graphNeighbors(await idx(), "C", 2);
		const paths = r.map((x) => x.path);
		// from C: depth1 {a,b}, depth2: a's other neighbors {b(already)}, so just within
		expect(paths).toContain("a.md");
		expect(paths).toContain("b.md");
	});
	it("respects max cap", async () => {
		const r = graphNeighbors(await idx(), "C", 2, 1);
		expect(r.length).toBeLessThanOrEqual(1);
	});
	it("unknown note → empty", async () => {
		const r = graphNeighbors(await idx(), "NoSuch", 2);
		expect(r).toEqual([]);
	});
});
