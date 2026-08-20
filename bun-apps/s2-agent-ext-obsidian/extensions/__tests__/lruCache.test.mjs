/**
 * A8 — true access-order LRU for the session file cache (readCached).
 *
 * readCached evicts the Map head when over OB_CACHE_MAX. Before A8 a hit
 * returned without re-inserting, so a hot note read repeatedly was evicted the
 * moment the cap filled — identical to a one-shot read. A8 re-inserts on hit so
 * the head is always the least-recently-USED entry.
 *
 * We assert eviction ORDER via the test-only __fileCacheOrder() snapshot
 * (LRU head → tail), since a re-read of an evicted entry still returns correct
 * content (silent cache miss) and is otherwise unobservable.
 *
 *   bun test extensions/__tests__/lruCache.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { readCached, invalidateCache, __fileCacheOrder } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

/** Map an abs cache key back to its vault-relative basename for readable asserts. */
const base = (p) => p.split(sep).pop();

let vault;
const SAVED_MAX = process.env.OB_CACHE_MAX;

beforeAll(async () => {
	vault = await makeFixture({});
});
afterAll(async () => {
	invalidateCache();
	if (SAVED_MAX === undefined) delete process.env.OB_CACHE_MAX;
	else process.env.OB_CACHE_MAX = SAVED_MAX;
	await rmFixture(vault);
});

beforeEach(() => {
	process.env.OB_CACHE_MAX = "3"; // small, deterministic working set
	invalidateCache();
});
afterEach(() => {
	invalidateCache();
});

async function touch(rel) {
	// distinct content per file so each cache entry is unambiguously its own
	await writeFile(join(vault, rel), `# ${rel}\n\nbody of ${rel}\n`, "utf8");
}

describe("A8 — readCached is access-order LRU", () => {
	it("evicts the least-recently-used entry, not the oldest insertion", async () => {
		await touch("a.md");
		await touch("b.md");
		await touch("c.md");
		// Fill the cache (cap = 3): order is [a, b, c].
		await readCached(join(vault, "a.md"));
		await readCached(join(vault, "b.md"));
		await readCached(join(vault, "c.md"));
		expect(__fileCacheOrder().map(base)).toEqual(["a.md", "b.md", "c.md"]);

		// Re-read a — a hot note. It must be promoted to the tail: [b, c, a].
		await readCached(join(vault, "a.md"));
		expect(__fileCacheOrder().map(base)).toEqual(["b.md", "c.md", "a.md"]);

		// Insert a 4th → over cap by 1 → evict the head (b, least-recently-used).
		// a survives because it was just touched.
		await touch("d.md");
		await readCached(join(vault, "d.md"));
		const names = __fileCacheOrder().map(base);
		expect(names).toContain("a.md"); // hot note survived
		expect(names).toContain("d.md"); // newest
		expect(names).not.toContain("b.md"); // LRU evicted
		expect(names.length).toBe(3);
	});

	it("a never-re-touched entry is evicted when it becomes the oldest", async () => {
		await touch("x.md");
		await touch("y.md");
		await touch("z.md");
		await readCached(join(vault, "x.md"));
		await readCached(join(vault, "y.md"));
		await readCached(join(vault, "z.md"));
		// cap full, no re-touches → inserting a 4th evicts the head (x).
		await touch("w.md");
		await readCached(join(vault, "w.md"));
		const names = __fileCacheOrder().map(base);
		expect(names).not.toContain("x.md");
		expect(names).toEqual(["y.md", "z.md", "w.md"]);
	});

	it("repeated reads keep a hot note resident across many cold inserts", async () => {
		await touch("hot.md");
		await readCached(join(vault, "hot.md"));
		// Cycle 5 cold notes through a cap-3 cache, re-touching hot each time.
		for (let i = 0; i < 5; i++) {
			await touch(`cold${i}.md`);
			await readCached(join(vault, `cold${i}.md`));
			await readCached(join(vault, "hot.md")); // promote
		}
		const names = __fileCacheOrder().map(base);
		expect(names).toContain("hot.md"); // never evicted despite churn
		expect(names.length).toBe(3);
	});

	it("respects a live OB_CACHE_MAX change (runtime-tunable)", async () => {
		await touch("p.md");
		await touch("q.md");
		await readCached(join(vault, "p.md"));
		await readCached(join(vault, "q.md"));
		process.env.OB_CACHE_MAX = "1"; // shrink to 1 mid-session
		expect(__fileCacheOrder().length).toBe(2); // not proactively trimmed
		await touch("r.md");
		await readCached(join(vault, "r.md")); // insert → trim to 1
		expect(__fileCacheOrder().length).toBe(1);
		process.env.OB_CACHE_MAX = "3";
	});

	it("a mtime-stale hit re-reads AND re-promotes", async () => {
		await touch("s.md");
		await readCached(join(vault, "s.md"));
		await touch("t.md");
		await readCached(join(vault, "t.md"));
		// external edit bumps s's mtime → next read is a cache miss (re-read)
		// but s must still land at the tail (most-recently-used), not the head.
		await writeFile(join(vault, "s.md"), "# s\n\nedited\n", "utf8");
		await readCached(join(vault, "s.md"));
		expect(__fileCacheOrder().map(base)).toEqual(["t.md", "s.md"]);
	});
});
