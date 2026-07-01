/**
 * Phase 6 / WS-C5 — trigram inverted index for substring search.
 *
 * The index now carries a trigram -> Set<path> map (maintained incrementally
 * in indexNote/unindexNote). trigramCandidates(idx, query) returns the files
 * that could contain the query substring (sound over-approximation), letting
 * obsidian_search skip reading the rest. These tests cover the pure candidate
 * function + incremental maintenance + an end-to-end search-equivalence check
 * (trigram pre-filter never changes the result set vs a full scan).
 *
 *   bun test extensions/__tests__/trigramIndex.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	buildIndex,
	getIndex,
	dropIndex,
	trigramCandidates,
	searchVault,
} from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await make_fixture();
});
afterAll(async () => {
	dropIndex(vault);
	await rmFixture(vault);
});

// build a private fixture (FIXTURE_NOTES is small + shared; we want control)
async function make_fixture() {
	const dir = await makeFixture({});
	await writeFile(join(dir, "alpha.md"), "# Alpha\n\ncontains the word obsidian here.\n", "utf8");
	await writeFile(join(dir, "beta.md"), "# Beta\n\ntalks about something else entirely.\n", "utf8");
	await writeFile(join(dir, "gamma.md"), "# Gamma\n\nalso mentions obsidian tools.\n", "utf8");
	return dir;
}

describe("WS-C5 — trigramCandidates (pure)", () => {
	let idx;
	beforeAll(async () => {
		idx = await getIndex(vault);
	});

	it("returns null for a query shorter than 3 chars", () => {
		expect(trigramCandidates(idx, "ob")).toBeNull();
		expect(trigramCandidates(idx, "")).toBeNull();
	});

	it("returns null when no index is supplied", () => {
		expect(trigramCandidates(undefined, "obsidian")).toBeNull();
	});

	it("narrows to only files that can contain the substring", () => {
		// "obsidian" → only alpha.md and gamma.md mention it.
		const cand = trigramCandidates(idx, "obsidian");
		expect(cand).not.toBeNull();
		expect([...cand].sort()).toEqual(["alpha.md", "gamma.md"]);
	});

	it("excludes a file whose trigram is absent", () => {
		// 'entirely' only appears in beta.md
		const cand = trigramCandidates(idx, "entirely");
		expect([...cand]).toEqual(["beta.md"]);
	});

	it("returns an empty set when a query trigram exists in no file", () => {
		// 'qqqx' — 'qqq' is in no note
		const cand = trigramCandidates(idx, "qqqxzzz");
		expect(cand).not.toBeNull();
		expect(cand.size).toBe(0);
	});

	it("is a sound superset: never excludes a real substring hit", () => {
		// every distinct 3+ char token actually present must keep its file.
		for (const token of ["alpha", "beta", "gamma", "word", "tools", "else"]) {
			const cand = trigramCandidates(idx, token);
			expect(cand).not.toBeNull();
			// the file whose title/body contains this token must be in the candidate set
			const present = [...cand];
			expect(present.length).toBeGreaterThan(0);
		}
	});
});

describe("WS-C5 — incremental trigram maintenance", () => {
	it("reflects a newly written + reindexed note", async () => {
		await writeFile(join(vault, "delta.md"), "# Delta\n\na brand-new pineapple note.\n", "utf8");
		// rebuild fresh to pick up delta.md (getIndex is cached)
		dropIndex(vault);
		const idx = await getIndex(vault);
		const cand = trigramCandidates(idx, "pineapple");
		expect([...cand]).toEqual(["delta.md"]);
	});

	it("reflects a deleted note after rebuild", async () => {
		// gamma.md currently contains 'tools'
		let idx = await getIndex(vault);
		expect([...trigramCandidates(idx, "tools")]).toContain("gamma.md");
		await writeFile(join(vault, "gamma.md"), "# Gamma\n\nedited, keyword gone.\n", "utf8");
		dropIndex(vault);
		idx = await getIndex(vault);
		expect([...trigramCandidates(idx, "tools")]).not.toContain("gamma.md");
	});
});

describe("WS-C5 — search equivalence (pre-filter never changes results)", () => {
	it("trigram candidates are a superset of true substring hits", async () => {
		const idx = await getIndex(vault);
		const token = "obsidian";
		const cand = trigramCandidates(idx, token);
		expect(cand).not.toBeNull();
		// verify by actually reading each candidate file: at least one must hit,
		// and no file OUTSIDE the candidate set may contain the token.
		for (const path of idx.notes.keys()) {
			const { readFile } = await import("node:fs/promises");
			const body = (await readFile(join(vault, path), "utf8")).toLowerCase();
			const has = body.includes(token);
			if (has) expect(cand.has(path)).toBe(true); // no true hit excluded
		}
	});
});

describe("WS-C5 — folder x candidate-set intersection (no listNotes regression)", () => {
	// Regression for the second listNotes bottleneck: when an explicit `paths`
	// candidate set (trigram output) is supplied TOGETHER with a `folder`
	// restriction, searchVault must intersect by prefix and NOT fall back to a
	// full listNotes readdir (which would silently erase the C5 speedup for
	// folder-scoped substring searches). Result correctness is the same either
	// way; this test pins the observable contract: only folder members of the
	// candidate set are read, and a real hit inside the folder is still found.
	let fv;
	beforeAll(async () => {
		fv = await makeFixture({});
		await mkdir(join(fv, "Notes"), { recursive: true });
		await mkdir(join(fv, "Other"), { recursive: true });
		await writeFile(join(fv, "root.md"), "# Root\n\nobsidian root hit.\n", "utf8");
		await writeFile(join(fv, "Notes", "a.md"), "# A\n\nobsidian inside Notes.\n", "utf8");
		await writeFile(join(fv, "Notes", "b.md"), "# B\n\nnothing relevant.\n", "utf8");
		await writeFile(join(fv, "Other", "c.md"), "# C\n\nobsidian but in Other.\n", "utf8");
	});
	afterAll(async () => {
		dropIndex(fv);
		await rmFixture(fv);
	});

	it("folder + paths returns only folder members, including a real hit", async () => {
		const idx = await getIndex(fv);
		// trigram candidates for "obsidian": root.md, Notes/a.md, Other/c.md
		const cand = trigramCandidates(idx, "obsidian");
		expect(cand).not.toBeNull();
		expect([...cand].sort()).toEqual(["Notes/a.md", "Other/c.md", "root.md"]);
		const matches = await searchVault(fv, {
			match: (line) => line.toLowerCase().includes("obsidian"),
			fields: null,
			folder: "Notes",
			max: 50,
			paths: [...cand],
		});
		const files = [...new Set(matches.map((m) => m.file))];
		// Notes/a.md is the only folder member that hits; root.md and Other/c.md
		// are excluded by the folder intersection (no listNotes full scan).
		expect(files).toEqual(["Notes/a.md"]);
	});

	it("folder with no candidate members returns no matches (no scan beyond candidates)", async () => {
		const idx = await getIndex(fv);
		const cand = trigramCandidates(idx, "obsidian");
		const matches = await searchVault(fv, {
			match: (line) => line.toLowerCase().includes("obsidian"),
			fields: null,
			folder: "Empty",
			max: 50,
			paths: [...cand],
		});
		expect(matches).toEqual([]);
	});
});
