/**
 * Phase 6 validation — exercise C5 (trigram search) + C6 (index persistence)
 * + the hardened query/garden tools on the REAL vault (a 33-note Chinese
 * Zettelkasten git submodule), where synthetic tests can't reach (real CJK
 * content + a real link graph).
 *
 * The submodule stays pristine: the C6 cache is redirected via
 * OB_INDEX_CACHE_DIR to /tmp. Run:
 *
 *   OB_VAULT_PATH=<vault> OB_INDEX_CACHE_DIR=/tmp/pi-obsidian-validate \
 *     bun run scripts/validate-real-vault.mjs
 *
 * Exits non-zero on any equivalence break or C6 round-trip mismatch.
 */
import { readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";

const mod = await import("../extensions/obsidian.ts");

const VAULT = process.env.OB_VAULT_PATH;
const CACHE_DIR = process.env.OB_INDEX_CACHE_DIR || "/tmp/pi-obsidian-validate";
if (!VAULT) {
	console.error("OB_VAULT_PATH must point at the vault under test");
	process.exit(2);
}
process.env.OB_INDEX_POLL_MS = "0";

// fake-pi harness (same shape as toolSmoke.test.mjs)
const tools = {};
const pi = {
	registerTool: (t) => { tools[t.name] = t; },
	registerCommand: () => {},
	on: () => {},
};
mod.default(pi);
const call = (name, params) => tools[name].execute("id", params, undefined, undefined, { cwd: VAULT });
const BIG_MAX = 10_000;

// ---- enumerate every note on disk (for brute-force equivalence) ----------
async function allNotes() {
	const out = [];
	async function walk(dir, rel = "") {
		for (const name of await readdir(dir, { withFileTypes: true })) {
			const p = join(dir, name.name);
			const r = rel ? `${rel}/${name.name}` : name.name;
			if (name.isDirectory()) {
				if (name.name === ".git" || name.name === ".cache" || name.name === ".obsidian") continue;
				await walk(p, r);
			} else if (name.name.endsWith(".md")) {
				out.push(r);
			}
		}
	}
	await walk(VAULT);
	return out;
}
const notePaths = await allNotes();
const bodies = new Map();
for (const p of notePaths) bodies.set(p, (await readFile(join(VAULT, p), "utf8")).toLowerCase());

/** brute-force substring file set */
function brute(q) {
	const ql = q.toLowerCase();
	return new Set([...bodies.entries()].filter(([, b]) => b.includes(ql)).map(([p]) => p));
}

/** obsidian_search result as a de-duped file set, with trigram on or off. */
async function searchFiles(q, trigramOn) {
	if (trigramOn) delete process.env.OB_TRIGRAM_SEARCH;
	else process.env.OB_TRIGRAM_SEARCH = "0";
	const r = await call("obsidian_search", { query: q, max: BIG_MAX });
	return new Set((r.details?.matches ?? []).map((m) => m.file));
}

// ---- pick real query tokens from the vault (CJK + ASCII), + adversarial ---
const sample = [...bodies.values()].join("\n");
const cjkTokens = [...new Set((sample.match(/[一-鿿]{3,6}/g) ?? []).slice(0, 40))].slice(0, 18);
const asciiTokens = [...new Set((sample.match(/[a-z]{5,12}/g) ?? []))].slice(0, 12);
const shortCjk = [...new Set((sample.match(/[一-鿿]{1,2}/g) ?? []))].slice(0, 6); // <3 chars → trigram null
const queries = [
	...cjkTokens.map((t) => ({ q: t, kind: "CJK≥3" })),
	...asciiTokens.map((t) => ({ q: t, kind: "ASCII" })),
	...shortCjk.map((t) => ({ q: t, kind: "CJK<3" })),
	{ q: "zzz_absent_token_xyz", kind: "absent" },
	{ q: "知識管理", kind: "CJK-handpicked" },
	{ q: "obsidian", kind: "ASCII-handpicked" },
];

let failures = 0;
function check(label, cond, detail = "") {
	console.error(`  ${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
	if (!cond) failures++;
}

// ---- 1. status ------------------------------------------------------------
console.error("\n[1] obsidian_status on the real vault");
const st = await call("obsidian_status", {});
check("status reports the vault path", st.details.active.path === VAULT);
check(`note count === ${notePaths.length} on disk`, st.details.active.noteCount === notePaths.length, `got ${st.details.active.noteCount}`);

// ---- 2. C5 search equivalence (trigram ON == trigram OFF == brute) -------
console.error("\n[2] C5 trigram search equivalence (on == off == brute force)");
console.error(`    ${queries.length} queries (${cjkTokens.length} CJK≥3, ${asciiTokens.length} ASCII, ${shortCjk.length} CJK<3, +adversarial)`);
for (const { q, kind } of queries) {
	const want = brute(q);
	const on = await searchFiles(q, true);
	const off = await searchFiles(q, false);
	const eqOnOff = on.size === off.size && [...on].every((p) => off.has(p));
	const eqBrute = on.size === want.size && [...on].every((p) => want.has(p));
	check(`"${q}" (${kind}): on==off`, eqOnOff, `${on.size}/${off.size}/${want.size} files`);
	check(`"${q}" (${kind}): on==brute`, eqBrute, `trigram dropped a real hit?`);
}

// ---- 3. query on the real tag graph --------------------------------------
console.error("\n[3] obsidian_query on the real tag graph");
const idx = await mod.getIndex(VAULT);
const tagSample = [...idx.byTag.keys()].slice(0, 5);
for (const tag of tagSample) {
	const r = await call("obsidian_query", { tags: [tag], max: BIG_MAX });
	const want = idx.byTag.get(tag).size;
	check(`tag "${tag}": query==index`, r.details.count === want, `${r.details.count}/${want}`);
}

// ---- 4. C6 round-trip on the real link graph -----------------------------
console.error("\n[4] C6 persistence round-trip (real link graph)");
await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
mod.dropIndex(VAULT);
const built = await mod.getIndex(VAULT);
await mod.saveIndex(built);
mod.dropIndex(VAULT);
const loaded = await mod.loadCachedIndex(VAULT);
check("loaded index is non-null", !!loaded);
if (loaded) {
	check("notes equal", built.notes.size === loaded.notes.size, `${built.notes.size}/${loaded.notes.size}`);
	let notesMatch = true;
	for (const [p, m] of built.notes) {
		const l = loaded.notes.get(p);
		if (!l) { notesMatch = false; break; }
		if (l.tags.join(",") !== m.tags.join(",") || l.title !== m.title) { notesMatch = false; break; }
	}
	check("per-note tags/title match", notesMatch);
	check("byTag equal", built.byTag.size === loaded.byTag.size, `${built.byTag.size}/${loaded.byTag.size}`);
	// backlink graph: reverseAdjacency keys that resolve to real paths
	const builtBack = new Map();
	for (const [k, v] of built.reverseAdjacency) if (built.notes.has(k)) builtBack.set(k, v.size);
	const loadedBack = new Map();
	for (const [k, v] of loaded.reverseAdjacency) if (loaded.notes.has(k)) loadedBack.set(k, v.size);
	const backsEq = builtBack.size === loadedBack.size && [...builtBack].every(([k, n]) => loadedBack.get(k) === n);
	check("real-path backlinks equal", backsEq);
	// trigram candidates survive the round-trip on a real CJK query
	const q = cjkTokens[0] ?? "obsidian";
	check("trigram candidates survive (CJK)", eqSet(mod.trigramCandidates(built, q), mod.trigramCandidates(loaded, q)));
}

// ---- 5. garden audit (only if pi resolvable; non-blocking) ---------------
console.error("\n[5] obsidian_garden audit (real subagent — best-effort)");
const piOk = await import("node:child_process").then(({ execFileSync }) => {
	try { execFileSync("which", ["pi"]); return true; } catch { return false; }
}).catch(() => false);
if (piOk && process.env.OB_SUBAGENT_MODEL) {
	const r = await call("obsidian_garden", { mode: "audit" });
	if (!r.isError && (r.content?.[0]?.text?.length ?? 0) > 0) {
		console.error("  ✓ garden audit produced a report (subagent live)");
	} else {
		// Not a C5/C6 correctness break — garden needs a configured LLM subagent
		// (OB_SUBAGENT_MODEL). Advisory only.
		console.error("  ⊘ garden subagent produced no output (likely no OB_SUBAGENT_MODEL / timeout) — advisory, not a C5/C6 failure");
	}
} else {
	console.error("  ⊘ skipped — `pi` not on PATH or OB_SUBAGENT_MODEL unset (garden live needs a configured LLM subagent; out of C5/C6 scope)");
}

await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});

console.error(`\n=== ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);

function eqSet(a, b) {
	if (a == null || b == null) return a == null && b == null;
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}
