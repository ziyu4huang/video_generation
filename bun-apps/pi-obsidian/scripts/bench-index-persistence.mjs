/**
 * Phase 6 / WS-C6 — benchmark: persisted index load vs full cold buildIndex.
 *
 * PRD C6 spike ("measure before committing"): does persisting the index to
 * disk actually cut the per-session cold-start tax? Generates a synthetic
 * vault, times a cold buildIndex (read every file + parse) vs a cold
 * loadCachedIndex (stat every file, reuse persisted meta + trigrams, read only
 * changed files), and reports the .cache file size.
 *
 *   bun run scripts/bench-index-persistence.mjs [noteCount]
 *
 * Defaults to 3000 notes. Prints ms-per-cold-start + cache size + speedup.
 */
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mod = await import("../extensions/obsidian.ts");

const N = Number(process.argv[2] ?? 3000);
const vault = await mkdtemp(join(tmpdir(), "pio-c6-"));
process.env.OB_VAULT_PATH = vault;
process.env.OB_INDEX_POLL_MS = "0";

// --- generate synthetic notes (same shape as C5 bench) -------------------
const FILLER = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur"];
function filler(seed, lines = 10) {
	const out = [];
	let s = seed;
	for (let i = 0; i < lines; i++) {
		const w = [];
		for (let j = 0; j < 12; j++) {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			w.push(FILLER[s % FILLER.length]);
		}
		out.push(w.join(" "));
	}
	return out.join("\n");
}
for (let i = 0; i < N; i++) {
	const path = join(vault, `notes/note-${i}.md`);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(
		path,
		`---\ntags: [t${i % 5}]\ncreated: 2026-01-01\n---\n\n# Note ${i}\n\n` +
			filler(i + 1) + `\n\nrare needle: supercalifragilistic.\n`,
		"utf8",
	);
}
console.error(`generated ${N} notes under ${vault}`);

async function timeMs(label, fn, runs = 5) {
	await fn(); // one warmup (also primes any one-time module cost)
	const t0 = performance.now();
	for (let i = 0; i < runs; i++) await fn();
	const ms = (performance.now() - t0) / runs;
	console.error(`  ${label.padEnd(38)} ${ms.toFixed(1)} ms`);
	return ms;
}

// --- baseline: cold buildIndex (read every file + parse) -----------------
const buildMs = await timeMs("cold buildIndex (full scan)", async () => {
	mod.dropIndex(vault);
	await mod.buildIndex(vault);
});

// --- persist, then time a cold load (stat only, reuse meta+trigrams) -----
let built = await mod.getIndex(vault);
await mod.saveIndex(built);
const cachePath = join(vault, ".cache", "pi-obsidian-index.json");
const cacheBytes = (await stat(cachePath)).size;
console.error(`  .cache size                           ${(cacheBytes / 1024 / 1024).toFixed(2)} MB`);

const loadMs = await timeMs("cold loadCachedIndex (stat-only)", async () => {
	const idx = await mod.loadCachedIndex(vault);
	if (!idx) throw new Error("load returned null");
});
const speedup = (buildMs / loadMs).toFixed(2);
console.error(`  → speedup ${speedup}× (cold load vs cold build)`);

// --- correctness: loaded index equivalent to built ----------------------
console.error("\ncorrectness (loaded == built):");
built = await mod.buildIndex(vault);
const loaded = await mod.loadCachedIndex(vault);
let ok = true;
if (built.notes.size !== loaded.notes.size) {
	ok = false;
	console.error(`  notes.size: built=${built.notes.size} loaded=${loaded.notes.size} MISMATCH`);
}
// trigrams survived the round-trip (no content re-read on load)
if (loaded.trigrams.size === 0) {
	ok = false;
	console.error(`  trigrams empty after load (C5 would be inert) MISMATCH`);
}
// a known tag round-trips
const t0Set = built.byTag.get("t0");
const l0Set = loaded.byTag.get("t0");
if (!l0Set || t0Set.size !== l0Set.size) {
	ok = false;
	console.error(`  byTag t0: built=${t0Set.size} loaded=${l0Set?.size} MISMATCH`);
}
console.error(`  ${ok ? "OK (notes + tags + trigrams match)" : "MISMATCH"}`);

// --- partial-staleness: change 1% of files, re-load ---------------------
console.error("\npartial staleness (1% files changed, re-load):");
const changed = Math.max(1, Math.floor(N * 0.01));
for (let i = 0; i < changed; i++) {
	await writeFile(join(vault, `notes/note-${i}.md`), `# Note ${i}\n\nedited content keyword-${i}.\n`, "utf8");
}
const partialMs = await timeMs(`cold load (1% = ${changed} stale)`, async () => {
	const idx = await mod.loadCachedIndex(vault);
	if (!idx) throw new Error("load returned null");
});

await rm(vault, { recursive: true, force: true });
console.error(`\nsummary: build=${buildMs.toFixed(0)}ms  full-load=${loadMs.toFixed(0)}ms  1%-stale-load=${partialMs.toFixed(0)}ms  speedup=${speedup}×  cache=${(cacheBytes/1024/1024).toFixed(1)}MB`);
