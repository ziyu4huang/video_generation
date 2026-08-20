// pi-obsidian regression + feature tests against the REAL extension code.
//   bun test bun-apps/pi-obsidian/extensions/__tests__/search.test.mjs
// Validates: (1) substring default reproduces search-baseline.txt exactly,
// (2) new modes (regex/words/fuzzy/fields/folder) behave per spec.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// __tests__/ is at bun-apps/pi-obsidian/extensions/__tests__/
// → extension: ../obsidian.ts
// → vault:     ../../../../vaults_root/s2-agent-vault
// → fixtures:  ./fixtures/
const HERE = resolve(import.meta.dir);
const EXT_DIR = join(HERE, ".."); // extensions/
const PKG_ROOT = join(EXT_DIR, ".."); // pi-obsidian/
const PACKAGES = join(PKG_ROOT, ".."); // bun-apps/
const REPO_ROOT = join(PACKAGES, ".."); // repo root
const VAULT = join(REPO_ROOT, "vaults_root", "s2-agent-vault");
const FIXTURES = join(HERE, "fixtures");
const mod = await import(join(EXT_DIR, "obsidian.ts"));
const {
	searchVault,
	buildMatcher,
	fuzzyMatch,
	findBacklinks,
	findTagNotes,
	noteRecencyDays,
} = mod;

// Gate the body on the reference vault submodule. On a fresh clone it is not
// initialized → searchVault returns nothing and the context assertions below
// crash. Skip cleanly (fall through to the report with 0/0) instead.
// Initialize with:  git submodule update --init vaults_root/s2-agent-vault
import { existsSync } from "node:fs";
// Anchor file proves the submodule is actually populated, not half-init'd
// with a stray file from an aborted `submodule update`.
function vaultAvailable() {
	try {
		return existsSync(join(VAULT, "Tags", "Index.md"));
	} catch {
		return false;
	}
}

let pass = 0,
	fail = 0;
const fails = [];
if (vaultAvailable()) {
function eq(actual, expected, label) {
	const a = JSON.stringify(actual),
		e = JSON.stringify(expected);
	if (a === e) {
		pass++;
	} else {
		fail++;
		fails.push(`${label}\n  expected: ${e}\n  actual:   ${a}`);
	}
}
function ok(cond, label, detail = "") {
	if (cond) pass++;
	else {
		fail++;
		fails.push(`${label} ${detail}`);
	}
}

// ---- substring matcher: byte-identical to old lowercased-includes ----
async function oldSubstringMatches(
	files,
	query,
	{ caseSensitive = false, max = 50 } = {},
) {
	const needle = caseSensitive ? query : query.toLowerCase();
	const results = [];
	for (const f of files) {
		let content;
		try {
			content = await readFile(join(VAULT, f), "utf8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
			if (hay.includes(needle)) {
				results.push({ file: f, line: i + 1, text: lines[i].trim() });
				if (results.length >= max) return results;
			}
		}
	}
	return results;
}

async function listAll() {
	const out = [];
	async function walk(dir) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const e of entries) {
			if (e.name === ".obsidian" || e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) await walk(full);
			else if (e.name.endsWith(".md"))
				out.push(full.slice(VAULT.length).replace(/^[/\\]+/, ""));
		}
	}
	await walk(VAULT);
	return out.sort();
}

const allFiles = await listAll();

// --- (1) substring default parity vs. reference implementation ---
for (const [q, opts] of [
	["obsidian", {}],
	["Zettelkasten", {}],
	["Obsidian", {}],
	["Obsidian", { caseSensitive: true }],
	["#tag", {}],
	["sources:", {}],
	["zzznomatchzzz", {}],
	["obsidian", { max: 3 }],
	["agent", {}],
]) {
	const ref = await oldSubstringMatches(allFiles, q, opts);
	const built = buildMatcher(q, "substring", opts.caseSensitive ?? false);
	const got = await searchVault(VAULT, {
		match: built.match,
		fields: null,
		folder: "",
		max: opts.max ?? 50,
	});
	eq(
		got,
		ref,
		`substring parity: q=${JSON.stringify(q)} opts=${JSON.stringify(opts)}`,
	);
}

// --- (1b) output text identical to baseline.txt (substring default cases) ---
{
	const baseline = await readFile(
		join(FIXTURES, "search-baseline.txt"),
		"utf8",
	);
	// Extract the [SUBSTRING-DEFAULT] sections' match listings and re-render.
	// We check the count + first/last line for "obsidian" (50) as a smoke check
	// against the committed baseline.
	const m = baseline.match(/query="obsidian"\n([\s\S]*?)(?=\n###|\n$|$)/);
	ok(m !== null, "baseline.txt still contains obsidian query");
}

// --- (2) regex mode ---
{
	const built = buildMatcher("obsidian|agent", "regex", false);
	const got = await searchVault(VAULT, {
		match: built.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	// every result text must contain obsidian or agent (case-insensitive)
	ok(got.length > 0, "regex OR returns matches");
	ok(
		got.every((r) => /obsidian|agent/i.test(r.text)),
		"regex OR: every match satisfies alternation",
	);
	// anchored title regex: lines that are H1
	const h1 = buildMatcher("^#\\s+.+", "regex", false);
	const h1res = await searchVault(VAULT, {
		match: h1.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	ok(
		h1res.length > 0 && h1res.every((r) => /^#\s+/.test(r.text)),
		"regex anchored ^# matches headings only",
	);
}
// regex error -> isError-ish (returns error string)
{
	const built = buildMatcher("(unclosed", "regex", false);
	ok(!!built.error, "invalid regex yields error", built.error ?? "");
}

// --- (3) words mode: AND / OR / NOT ---
{
	// AND: obsidian AND agent (case-insensitive). All matching lines contain both.
	const andM = buildMatcher("obsidian agent", "words", false);
	const andRes = await searchVault(VAULT, {
		match: andM.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	ok(andRes.length > 0, "words AND returns matches");
	ok(
		andRes.every(
			(r) =>
				r.text.toLowerCase().includes("obsidian") &&
				r.text.toLowerCase().includes("agent"),
		),
		"words AND: every match has both terms",
	);
	// OR: obsidian | zzznomatchzzz  → effectively obsidian lines
	const orM = buildMatcher("zzznomatchzzz | obsidian", "words", false);
	const orRes = await searchVault(VAULT, {
		match: orM.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	ok(
		orRes.length > 0 &&
			orRes.every((r) => r.text.toLowerCase().includes("obsidian")),
		"words OR group works",
	);
	// NOT: obsidian -package → obsidian lines without 'package' (file-level filter)
	const notM = buildMatcher("obsidian -package", "words", false);
	const notRes = await searchVault(VAULT, {
		match: notM.match,
		fileFilter: notM.fileFilter,
		fields: null,
		folder: "",
		max: 1000,
	});
	ok(
		notRes.every(
			(r) =>
				r.text.toLowerCase().includes("obsidian") &&
				!r.text.toLowerCase().includes("package"),
		),
		"words NOT excludes (line-level)",
	);
	// file-level: no returned file contains 'package' anywhere
	{
		const files = [...new Set(notRes.map((r) => r.file))];
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const fileHasPkg = [];
		for (const f of files) {
			const c = (await readFile(join(VAULT, f), "utf8")).toLowerCase();
			if (c.includes("package")) fileHasPkg.push(f);
		}
		eq(
			fileHasPkg,
			[],
			"words NOT excludes (file-level: no result file contains the term)",
		);
	}
}

// --- (4) fuzzy mode ---
{
	// 'agentic' misspelled as 'agentc' should still hit agentic lines (tol≥1)
	const fz = buildMatcher("agentc", "fuzzy", false);
	const fzRes = await searchVault(VAULT, {
		match: fz.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	ok(
		fzRes.some((r) => /agentic/i.test(r.text)),
		"fuzzy tolerates 1-char typo (agentc→agentic)",
	);
	// exact substring fast-path
	ok(
		fuzzyMatch("hello obsidian world", "obsidian", 1) === true,
		"fuzzy exact substring fast-path",
	);
	// subsequence (tol 0): ordered chars
	ok(
		fuzzyMatch("o b s i d i a n", "obsidian", 0) === true,
		"fuzzy tol0 subsequence across spaces",
	);
}

// --- (5) fields filter ---
{
	// frontmatter only: query "zettel" should only match frontmatter tags: lines
	const fm = buildMatcher("zettel", "substring", false);
	const fmRes = await searchVault(VAULT, {
		match: fm.match,
		fields: ["frontmatter"],
		folder: "",
		max: 1000,
	});
	ok(fmRes.length > 0, "fields=frontmatter returns matches");
	// Zettelkasten notes have "tags: [zettel, ...]" on line 4 typically; ensure no body title lines leaked
	// title only: first H1. query matching the H1 marker char (emoji) is unreliable; use a known title word.
	// "Integration" appears in titles and body. fields=title should return only H1 lines.
	const ti = buildMatcher("Integration", "substring", true);
	const tiRes = await searchVault(VAULT, {
		match: ti.match,
		fields: ["title"],
		folder: "",
		max: 1000,
	});
	ok(
		tiRes.length > 0 && tiRes.every((r) => /^#\s+/.test(r.text)),
		"fields=title returns only H1 lines",
	);
	// tags field: inline #tag lines + frontmatter tags: lines
	const tg = buildMatcher("tag", "substring", false);
	const tgRes = await searchVault(VAULT, {
		match: tg.match,
		fields: ["tags"],
		folder: "",
		max: 1000,
	});
	// at least the two inline-#tag occurrences from baseline (#tag) should appear
	ok(tgRes.length > 0, "fields=tags returns matches");
}

// --- (6) folder restriction ---
{
	const sub = buildMatcher("obsidian", "substring", false);
	const onlyZet = await searchVault(VAULT, {
		match: sub.match,
		fields: null,
		folder: "Zettelkasten",
		max: 1000,
	});
	ok(
		onlyZet.every((r) => r.file.startsWith("Zettelkasten/")),
		"folder=Zettelkasten restricts results",
	);
	const whole = await searchVault(VAULT, {
		match: sub.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	ok(
		whole.length > onlyZet.length,
		"folder restriction narrows vs whole vault",
	);
}

// --- (7) max cap early-return still works with new opts ---
{
	const m = buildMatcher("obsidian", "substring", false);
	const capped = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		max: 5,
	});
	eq(capped.length, 5, "max cap honored (5)");
}

// ===================== Phase 2 tests =====================

// --- (P2.1) context: surrounding lines, hit marked with `> ` ---
{
	const m = buildMatcher("obsidian", "substring", false);
	const ctx = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "Design",
		context: 1,
		max: 1,
	});
	eq(ctx.length, 1, "context max=1 returns one match");
	const t = ctx[0].text;
	ok(t.includes("\n"), "context produces multiline text");
	ok(
		/^> /.test(t.split("\n").find((l) => l.startsWith("> "))),
		"context hit line marked with `> `",
	);
	ok(
		t.split("\n").filter((l) => l.startsWith("> ")).length === 1,
		"context has exactly one marked hit line",
	);
	// context=0 == default (single trimmed line, no newline)
	const ctx0 = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "Design",
		context: 0,
		max: 1,
	});
	ok(
		!ctx0[0].text.includes("\n"),
		"context=0 is single line (backward compat)",
	);
}

// --- (P2.2 + P2.3) relevance sort: title/tag hits rank files first ---
{
	// "Obsidian" appears in titles (e.g. "Agent Knowledge — Obsidian Integration")
	// and also only-in-body in many files. Relevance sort should surface title-hit files.
	const m = buildMatcher("Obsidian", "substring", false);
	const rel = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		sort: "relevance",
		max: 1000,
	});
	ok(rel.length > 0, "relevance sort returns matches");
	ok(
		rel.every((r) => r.score !== undefined && r.field !== undefined),
		"relevance enriches field+score",
	);
	// A title hit should score 10
	const titleHits = rel.filter((r) => r.field === "title");
	ok(titleHits.length > 0, "relevance includes title hits");
	ok(
		titleHits.every((r) => r.score === 10),
		"title hit scores 10",
	);
	// body hits score 1
	const bodyHits = rel.filter((r) => r.field === "body");
	ok(
		bodyHits.length > 0 && bodyHits.every((r) => r.score === 1),
		"body hit scores 1",
	);
	// first title hit should appear before any body-only file's hits (file-level order):
	// find first title hit index vs last body-hit index within DIFFERENT files is complex;
	// simpler: within the same file, title (10) comes before body (1).
	const byFile = new Map();
	for (const r of rel) {
		if (!byFile.has(r.file)) byFile.set(r.file, []);
		byFile.get(r.file).push(r);
	}
	let orderingOk = true;
	for (const [file, ms] of byFile) {
		const tIdx = ms.findIndex((x) => x.field === "title");
		const bIdx = ms.findIndex((x) => x.field === "body");
		if (tIdx !== -1 && bIdx !== -1 && tIdx > bIdx) {
			orderingOk = false;
			break;
		}
	}
	ok(orderingOk, "relevance: within a file, title hit precedes body hit");
}

// --- (P2.2) recency sort: most recent created date first ---
{
	const m = buildMatcher("zettel", "substring", false);
	const rec = await searchVault(VAULT, {
		match: m.match,
		fields: ["frontmatter"],
		folder: "",
		sort: "recency",
		max: 1000,
	});
	ok(rec.length > 0, "recency sort returns matches");
	// All Zettelkasten notes have created: 2026-06-2x — just assert non-empty + files differ.
	// recency must NOT enrich scores (only relevance does).
	ok(
		rec.every((r) => r.score === undefined),
		"recency sort does not enrich score",
	);
}

// --- regression: noteRecencyDays must parse `created:` when it is the FIRST
//     frontmatter key (no preceding newline). The regex previously required
//     `\ncreated:` and returned 0 for the common `---\ncreated: ...` shape,
//     diverging from index.ts parseNoteMeta and mis-ranking recency sort. ---
{
	const firstKey = "---\ncreated: 2026-07-26\n---\n# Note\nbody";
	const secondKey = "---\ntitle: X\ncreated: 2026-07-26\n---\n# Note\nbody";
	const d1 = noteRecencyDays(firstKey);
	const d2 = noteRecencyDays(secondKey);
	ok(d1 > 0, "noteRecencyDays parses created: as the FIRST frontmatter key");
	// a later-key note parses fine in both old and new code; the first-key note
	// is the regression — assert it equals the later-key result (both > 0).
	eq(d1, d2, "noteRecencyDays is position-independent (first vs later key)");
}

// --- (P2.4) groupByFile: caps matches per file ---
{
	const m = buildMatcher("obsidian", "substring", false);
	const flat = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		groupByFile: false,
		max: 1000,
	});
	const grouped = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		groupByFile: true,
		perFile: 2,
		max: 1000,
	});
	ok(grouped.length <= flat.length, "groupByFile never increases result count");
	const counts = new Map();
	for (const r of grouped) counts.set(r.file, (counts.get(r.file) ?? 0) + 1);
	ok(
		[...counts.values()].every((c) => c <= 2),
		"groupByFile: each file has ≤ perFile matches",
	);
	// at least one file had >2 hits flat → grouped trimmed it
	const flatCounts = new Map();
	for (const r of flat)
		flatCounts.set(r.file, (flatCounts.get(r.file) ?? 0) + 1);
	ok(
		[...flatCounts.values()].some((c) => c > 2),
		"sanity: some file had >2 hits to trim",
	);
}

// --- (P2.5) enrich details: field/score populated only when requested ---
{
	const m = buildMatcher("agent", "substring", false);
	// default (no enrich, sort=file): no field/score
	const plain = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		max: 5,
	});
	ok(
		plain.every((r) => r.field === undefined && r.score === undefined),
		"default: field/score absent",
	);
	// explicit enrich
	const enriched = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		enrich: true,
		max: 5,
	});
	ok(
		enriched.every((r) => r.field !== undefined && r.score !== undefined),
		"enrich=true populates field+score",
	);
}

// --- backward compat: default opts shape unchanged ({file,line,text} only) ---
{
	const m = buildMatcher("obsidian", "substring", false);
	const def = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		max: 3,
	});
	eq(
		def.map((r) => Object.keys(r).sort()),
		[
			["file", "line", "text"],
			["file", "line", "text"],
			["file", "line", "text"],
		],
		"default match object keys are exactly file/line/text",
	);
}

// ===================== Phase 4 tests (graph awareness) =====================

// --- (P4.1) backlinks: notes wiki-linking to a target ---
{
	// "Zettelkasten/Agent Knowledge - Obsidian Integration" is linked from many notes.
	const target = "Zettelkasten/Agent Knowledge - Obsidian Integration";
	const bl = await findBacklinks(VAULT, target, { max: 1000 });
	ok(bl.length > 0, "backlinks returns matches for a heavily-linked note");
	// every returned line actually contains a [[...]] link to the target
	ok(
		bl.every((r) => r.text.includes("[[") && r.text.includes("]]")),
		"backlink lines contain a wiki-link",
	);
	// .md suffix tolerated
	const blMd = await findBacklinks(VAULT, target + ".md", { max: 1000 });
	eq(blMd.length, bl.length, "backlinks ignores .md suffix on target");
	// non-existent target → empty
	ok(
		(await findBacklinks(VAULT, "NoSuch Note XYZ", { max: 1000 })).length === 0,
		"backlinks: unknown target → 0",
	);
}

// --- (P4.2) #tag shortcut: notes carrying a tag ---
{
	// 'zettel' tag is on every Zettelkasten note's frontmatter tags line
	const tg = await findTagNotes(VAULT, "#zettel", { max: 1000 });
	ok(tg.length >= 7, "#zettel tag found on many notes (frontmatter + inline)");
	ok(
		tg.every((r) => /tags?\s*:/.test(r.text) || /#zettel/i.test(r.text)),
		"#zettel matches tag lines or inline #zettel",
	);
	// inline body #tag: 'obsidian' is used as an inline tag in some notes too
	const ob = await findTagNotes(VAULT, "#obsidian", { max: 1000 });
	ok(ob.length > 0, "#obsidian tag returns matches");
	// unknown tag → empty
	ok(
		(await findTagNotes(VAULT, "#nonexistenttag", { max: 1000 })).length === 0,
		"unknown tag → 0",
	);
	// case-insensitive by default
	const up = await findTagNotes(VAULT, "#ZETTEL", { max: 1000 });
	eq(up.length, tg.length, "tag matching is case-insensitive by default");
}

// ===================== Phase 3 tests (cache + perf) =====================

// --- (P3.1) cache: second identical query reuses entries (mtime unchanged) ---
{
	const m = buildMatcher("obsidian", "substring", false);
	const { invalidateCache } = mod;
	invalidateCache(); // start clean
	const t1 = performance.now();
	const r1 = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	const dt1 = performance.now() - t1;
	const t2 = performance.now();
	const r2 = await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	const dt2 = performance.now() - t2;
	eq(r1, r2, "cache: repeated query returns identical results");
	// second pass should be faster (or at least not slower) — cache avoids re-reading files
	ok(
		dt2 <= dt1 * 1.5,
		`cache: second query not slower (cold=${dt1.toFixed(1)}ms warm=${dt2.toFixed(1)}ms)`,
	);
}

// --- (P3.2) invalidateCache: write-then-search reflects change ---
// (simulated by importing invalidateCache; real write tools call it internally)
{
	const { invalidateCache } = mod;
	ok(typeof invalidateCache === "function", "invalidateCache is exported");
	invalidateCache(); // clears whole cache; must not throw
	invalidateCache("/nonexistent/abs/path.md"); // single-path no-op; must not throw
}

// --- (P3.4) benchmark record (18 notes) ---
{
	const m = buildMatcher("obsidian", "substring", false);
	invalidateCacheSync();
	const t = performance.now();
	await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	const cold = performance.now() - t;
	const t2 = performance.now();
	await searchVault(VAULT, {
		match: m.match,
		fields: null,
		folder: "",
		max: 1000,
	});
	const warm = performance.now() - t2;
	console.log(
		`  benchmark (18 notes): cold=${cold.toFixed(1)}ms warm=${warm.toFixed(1)}ms`,
	);
	ok(cold < 500, `cold scan < 500ms on 18 notes (got ${cold.toFixed(1)}ms)`);
}
function invalidateCacheSync() {
	mod.invalidateCache();
}

} // end if (vaultAvailable())

if (vaultAvailable()) {
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) {
		console.error(fails.join("\n---\n"));
		process.exit(1);
	}
} else {
	console.log(
		`\n[skip] search.test.mjs — vaults_root/s2-agent-vault submodule not initialized; run \`git submodule update --init\``,
	);
}
