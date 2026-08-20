/**
 * Phase 6 / WS-C6 — cross-session index persistence.
 *
 * The index used to be a module-level Map cleared on exit, so every fresh
 * session paid a full O(n) buildIndex. Now getIndex() loads a persisted index
 * from <vault>/.cache/pi-obsidian-index.json and stat-validates it: unchanged
 * notes reuse their cached meta (incl. trigrams — no content re-read), only
 * changed/new notes are re-read.
 *
 *   bun test extensions/__tests__/indexPersistence.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	getIndex,
	dropIndex,
	buildIndex,
	saveIndex,
	loadCachedIndex,
	serializeIndex,
} from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"a.md": "---\ntags: [x]\ncreated: 2026-01-01\n---\n\n# Alpha\n\nbody alpha obsidian.\n",
		"b.md": "# Beta\n\ntalks about other stuff.\n",
	});
	process.env.OB_INDEX_POLL_MS = "0";
});
afterAll(async () => {
	dropIndex(vault);
	await rmFixture(vault);
});

beforeEach(async () => {
	// Reset the vault to a clean a.md/b.md state so tests that add/edit/delete
	// notes don't pollute each other. Also clears the module index cache + any
	// persisted .cache file.
	dropIndex(vault);
	for (const name of await readdir(vault).catch(() => [])) {
		await rm(join(vault, name), { recursive: true, force: true }).catch(() => {});
	}
	await writeFile(join(vault, "a.md"), "---\ntags: [x]\ncreated: 2026-01-01\n---\n\n# Alpha\n\nbody alpha obsidian.\n", "utf8");
	await writeFile(join(vault, "b.md"), "# Beta\n\ntalks about other stuff.\n", "utf8");
});
afterEach(() => {
	dropIndex(vault);
});

async function freshLoad() {
	// build + persist explicitly (deterministic — getIndex's save is fire-and-forget)
	const idx = await getIndex(vault);
	await saveIndex(idx);
	dropIndex(vault);
	return getIndex(vault); // cold → should load from .cache
}

describe("WS-C6 — serializeIndex", () => {
	it("round-trips notes with their trigrams", async () => {
		const idx = await getIndex(vault);
		const ser = serializeIndex(idx);
		expect(ser.version).toBe(1);
		expect(ser.notes.length).toBe(2);
		const a = ser.notes.find((n) => n.path === "a.md");
		expect(a.trigrams.length).toBeGreaterThan(0);
		expect(a.tags).toEqual(["x"]);
	});
});

describe("WS-C6 — loadCachedIndex reuses persisted meta", () => {
	it("a cold load produces an equivalent index without rebuilding from scratch", async () => {
		const built = await getIndex(vault);
		await saveIndex(built);
		dropIndex(vault);

		const loaded = await loadCachedIndex(vault);
		expect(loaded).not.toBeNull();
		expect(loaded.notes.size).toBe(2);
		expect([...loaded.notes.keys()].sort()).toEqual(["a.md", "b.md"]);
		// trigrams survived across the load (no content re-read needed)
		expect(loaded.trigrams.size).toBeGreaterThan(0);
		expect(loaded.byTag.get("x")).toEqual(new Set(["a.md"]));
	});

	it("getIndex falls back to loadCachedIndex on a cold cache-miss", async () => {
		const idx = await freshLoad();
		expect(idx.notes.size).toBe(2);
		// C5 trigram search still works off the persisted+loaded index
		expect(idx.trigrams.size).toBeGreaterThan(0);
	});

	it("a note edited on disk is re-read on load (mtime changed)", async () => {
		await getIndex(vault);
		await saveIndex(await getIndex(vault));
		dropIndex(vault);
		// external edit
		await writeFile(join(vault, "a.md"), "---\ntags: [x, added]\ncreated: 2026-01-01\n---\n\n# Alpha\n\nnew keyword foobarbaz.\n", "utf8");
		const loaded = await loadCachedIndex(vault);
		const a = loaded.notes.get("a.md");
		expect(a.tags).toEqual(expect.arrayContaining(["added"]));
		expect([...a.trigrams]).toEqual(expect.arrayContaining(["foo", "oob", "oba", "bar"]));
	});

	it("a note added on disk is indexed on load", async () => {
		await getIndex(vault);
		await saveIndex(await getIndex(vault));
		dropIndex(vault);
		await writeFile(join(vault, "c.md"), "# Gamma\n\nfresh note.\n", "utf8");
		const loaded = await loadCachedIndex(vault);
		expect(loaded.notes.has("c.md")).toBe(true);
		expect(loaded.notes.size).toBe(3);
	});

	it("a note deleted on disk is dropped on load", async () => {
		await getIndex(vault);
		await saveIndex(await getIndex(vault));
		dropIndex(vault);
		await rm(join(vault, "b.md")).catch(() => {});
		const loaded = await loadCachedIndex(vault);
		expect(loaded.notes.has("b.md")).toBe(false);
		expect(loaded.notes.size).toBe(1);
	});
});

describe("WS-C6 — fallbacks", () => {
	it("returns null when no cache file exists", async () => {
		expect(await loadCachedIndex(vault)).toBeNull();
	});

	it("returns null when the cache is the wrong version", async () => {
		await mkdir(join(vault, ".cache"), { recursive: true });
		await writeFile(
			join(vault, ".cache", "pi-obsidian-index.json"),
			JSON.stringify({ version: 999, notes: [] }),
			"utf8",
		);
		expect(await loadCachedIndex(vault)).toBeNull();
	});

	it("returns null when OB_INDEX_PERSIST=0", async () => {
		const idx = await getIndex(vault);
		await saveIndex(idx);
		process.env.OB_INDEX_PERSIST = "0";
		try {
			expect(await loadCachedIndex(vault)).toBeNull();
		} finally {
			delete process.env.OB_INDEX_PERSIST;
		}
	});

	it("produces the same backlink graph as a fresh build", async () => {
		// build a vault where b links to a
		const v = await makeFixture({
			"a.md": "# Alpha\n\nbody.\n",
			"b.md": "# Beta\n\nsee [[Alpha]].\n",
		});
		try {
			const built = await getIndex(v);
			await saveIndex(built);
			dropIndex(v);
			const loaded = await loadCachedIndex(v);
			// reverseAdjacency: a.md (Alpha) <- b
			const back = loaded.reverseAdjacency.get("a.md");
			expect(back && [...back]).toEqual(["b.md"]);
		} finally {
			dropIndex(v);
			await rmFixture(v);
		}
	});
});
