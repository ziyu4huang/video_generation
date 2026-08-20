/**
 * Phase 6 / WS-C5 — benchmark: trigram pre-filter vs full-scan substring search.
 *
 * Spikes the question PRD C5 asks ("measure before committing"): does the
 * trigram inverted index actually speed up substring search enough to justify
 * its memory cost? Generates a synthetic vault, warms the index + file cache,
 * then times the same query (a) through obsidian_search (trigram candidates on)
 * and (b) a forced full-san baseline (candidates suppressed), over a few queries.
 *
 *   bun run scripts/bench-trigram-search.mjs [noteCount]
 *
 * Defaults to 2000 notes. Prints ms-per-search + candidate-reduction ratio.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mod = await import("../extensions/obsidian.ts");

const N = Number(process.argv[2] ?? 2000);
const vault = await mkdtemp(join(tmpdir(), "pio-bench-"));
process.env.OB_VAULT_PATH = vault;
// Use a realistic poll interval so refreshIndex is throttled after the first
// refresh (steady state) — not 0, which forces a full re-stat every search.
process.env.OB_INDEX_POLL_MS = "60000";

// --- generate synthetic notes --------------------------------------------
// ~80% notes about "lorem ipsum" filler, ~10% mentioning a rare needle, ~10%
// a common needle — mirrors a real vault where most queries match few files.
const FILLER_WORDS = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing"];
function filler(seed, lines = 12) {
	const out = [];
	let s = seed;
	for (let i = 0; i < lines; i++) {
		const words = [];
		for (let j = 0; j < 14; j++) {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			words.push(FILLER_WORDS[s % FILLER_WORDS.length]);
		}
		out.push(words.join(" "));
	}
	return out.join("\n");
}

const RARE = "supercalifragilistic";
const COMMON = "meeting";
let rareCount = 0;
let commonCount = 0;
for (let i = 0; i < N; i++) {
	const path = join(vault, `notes/note-${i}.md`);
	await mkdir(join(path, ".."), { recursive: true });
	const r = i % 10;
	let body = `# Note ${i}\n\n` + filler(i + 1);
	if (r === 0) {
		body += `\n\nrare needle: ${RARE} expansion.\n`;
		rareCount++;
	} else if (r === 1 || r === 2) {
		body += `\n\nthis ${COMMON} note discusses ${COMMON} agendas.\n`;
		commonCount++;
	}
	await writeFile(path, body, "utf8");
}
console.error(`generated ${N} notes under ${vault}`);
console.error(`  rare "${RARE}" in ${rareCount} notes; "${COMMON}" in ${commonCount} notes`);

// --- warm index + file cache ---------------------------------------------
const idx = await mod.getIndex(vault);
console.error(`index: ${idx.notes.size} notes, ${idx.trigrams.size} trigrams`);

// --- fake-pi harness so we can call the tool directly --------------------
const tools = {};
const pi = {
	registerTool: (t) => { tools[t.name] = t; },
	registerCommand: () => {},
	on: () => {},
};
mod.default(pi);
const search = (params) => tools["obsidian_search"].execute("id", params, undefined, undefined, { cwd: vault });

// all note paths, to force a full-scan baseline (an explicit `paths` overrides
// the trigram candidate filter in obsidian_search).
const ALL_PATHS = Array.from({ length: N }, (_, i) => `notes/note-${i}.md`);
const BIG_MAX = N + 10; // neutralize the default 50-result cap for comparison

async function timeIt(label, fn, runs = 20) {
	await fn(); // warmup
	const t0 = performance.now();
	for (let i = 0; i < runs; i++) await fn();
	const ms = (performance.now() - t0) / runs;
	console.error(`  ${label.padEnd(40)} ${ms.toFixed(3)} ms/search`);
	return ms;
}

console.error("\nsubstring search — trigram candidates ON vs full-scan baseline:");
for (const q of [RARE, COMMON]) {
	const on = await timeIt(`"${q}" trigram-on`, () => search({ query: q, max: BIG_MAX }));
	const off = await timeIt(`"${q}" full-scan (paths=all)`, () => search({ query: q, max: BIG_MAX, paths: ALL_PATHS }));
	const cand = mod.trigramCandidates(idx, q);
	const speedup = (off / on).toFixed(2);
	console.error(`    → candidate set ${cand ? cand.size : "all"}/${N} (${cand ? ((cand.size / N) * 100).toFixed(1) : "100"}%), speedup ${speedup}×`);
}

// --- correctness: trigram search must equal a brute full-scan -------------
console.error("\ncorrectness (trigram result set == brute-force substring):");
// avoid ultra-high-frequency tokens (e.g. "lorem"): they produce many matches
// per file, which the `max` cap truncates, making file-count comparison unfair.
const queries = [RARE, COMMON, "ipsumnonexistent", "fragilistic", "expansion"];
let allOk = true;
const { readFile } = await import("node:fs/promises");
for (const q of queries) {
	const res = await search({ query: q, max: BIG_MAX });
	const got = [...new Set((res.details?.matches ?? []).map((m) => m.file))].sort();
	// brute force
	const brute = [];
	for (let i = 0; i < N; i++) {
		const p = `notes/note-${i}.md`;
		const body = await readFile(join(vault, p), "utf8");
		if (body.toLowerCase().includes(q.toLowerCase())) brute.push(p);
	}
	brute.sort();
	const ok = JSON.stringify(got) === JSON.stringify(brute);
	if (!ok) allOk = false;
	console.error(`  "${q}": search=${got.length} brute=${brute.length} ${ok ? "OK" : "MISMATCH"}`);
}

await rm(vault, { recursive: true, force: true });
console.error(`\nresult: ${allOk ? "all queries match brute force" : "MISMATCH detected"}`);
