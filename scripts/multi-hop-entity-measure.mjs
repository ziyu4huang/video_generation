#!/usr/bin/env node
// @ts-nocheck
/**
 * multi-hop-entity-measure.mjs — Track 3.3 ENTITY LAYER measure (SAG idea ①).
 *
 * HYPOTHESIS: the multi-hop ruler's null-rank failures (2nd expected card NOT in
 * the tag-pool) are RECALL-side. A fine-grained ENTITY layer — entities extracted
 * from card content, bridging cards that share a concept but not query tags —
 * could surface the 2nd card via entity→card→entity expansion. This is the
 * structural bet SAG idea ④ predicts wins. The number decides, not the prior.
 *
 * WHAT THIS DOES (measure-first — NON-MUTATING; entities cached to a JSON file,
 * NOT written to the shared vault):
 *   1. Extract entities (name+type) for EVERY card in the convergence folder via
 *      gemma-4-26b (LM Studio :1234). Cached at output/.../entities.json so re-runs
 *      are free. Concurrency-pooled. ~449 cards.
 *   2. Build an entity→cards inverted index over the FULL folder (so expansion can
 *      surface cards OUTSIDE the tag-pool — the recall-side fix).
 *   3. New retrieval: tag-seed (retrieveRecords top-60 → rank top-S) → seedEntities
 *      → expand to ALL cards sharing ≥1 entity → rank the union by
 *      (sharedTags + entitySharedWithSeeds) → top-K.
 *   4. Measure setRecall@4 (entity-expand) vs the baseline (tag-rank, 0.567) +
 *      fullRecall@4. Gate: >=+0.10 setRecall@4 to SHIP (then persist entities as
 *      additive frontmatter + port expansion to retrieve.ts); else RETIRE.
 *
 * The entity-extraction prompt asks for SPECIFIC entities (tool/function/error/
 * concept), not generic tags — that finer granularity is the whole point vs the
 * existing coarse tag graph.
 */
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const FOLDER = "Zettelkasten/knowledge-graph";
const EVAL_FILE = join(REPO, "scripts/multi-hop-eval.json");
const OUT_DIR = join(REPO, "output/multi-hop-entity-measurements");
const ENTITIES_CACHE = join(OUT_DIR, "entities.json");
const LM_URL = process.env.LM_URL ?? "http://127.0.0.1:1234/v1/chat/completions";
const MODEL = process.env.ENTITY_MODEL ?? "google/gemma-4-26b-a4b-qat";
const CONCURRENCY = Number(process.env.ENTITY_CONCURRENCY ?? 6);
const SEED_COUNT = Number(process.env.ENTITY_SEEDS ?? 8); // tag-rank top-S seeds
const KS = [4, 8, 16];

function queryToTags(q) {
	return q.toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim().split(/\s+/).filter((t) => t.length >= 3 && t.length <= 30).slice(0, 10);
}
function rankWith(cards, boost) {
	return cards.map((c) => ({ c, s: c.sharedTags + (boost && c.hasCallouts ? 0.5 : 0) })).sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id)).map((x) => x.c);
}
function cardMatches(c, expect) { return `${c.path} ${c.id} ${c.title}`.toLowerCase().includes(expect.toLowerCase()); }
function normName(n) { return n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function extractEntities(cardFile, title, body) {
	const prompt = `Extract the 3 to 8 most SPECIFIC named entities from this technical knowledge card. Entities = concrete tools, functions, files, CLI flags, error messages, or distinct concepts that characterize the card — NOT generic words like "memory", "gotcha", "review", "config", "error". Prefer multi-word specific terms (e.g. "argparse shared parser", "resolveVault tier-2", "fp8 compute", "bun.lock", "VAE decode range").

Card title: ${title}
Card body (truncated): ${body.slice(0, 700)}

Respond with ONLY a JSON array of objects, each {"name": "...", "type": "tool|function|file|error|concept|flag|other"}. No prose.`;
	const res = await fetch(LM_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } }),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`LM ${res.status}`);
	const data = await res.json();
	const text = data.choices?.[0]?.message?.content ?? "";
	const m = text.match(/\[[\s\S]*\]/);
	if (!m) return [];
	try {
		const arr = JSON.parse(m[0]);
		return arr.filter((e) => e && typeof e.name === "string").map((e) => ({ name: normName(e.name), type: String(e.type ?? "other") })).filter((e) => e.name.length > 1).slice(0, 8);
	} catch { return []; }
}

async function pool(items, n, fn) {
	const ret = new Array(items.length);
	let i = 0;
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
		while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
	}));
	return ret;
}

async function main() {
	const vault = (await resolveVault(REPO)).path;
	mkdirSync(OUT_DIR, { recursive: true });
	const folderDir = join(vault, FOLDER);

	// ── 1. Load / extract entities for every card in the folder ───────────────
	let cache = {};
	if (existsSync(ENTITIES_CACHE)) { try { cache = JSON.parse(readFileSync(ENTITIES_CACHE, "utf8")); } catch {} }
	const allCards = readdirSync(folderDir).filter((n) => n.endsWith(".md"));
	const todoCards = allCards.filter((n) => !cache[n]);
	console.log(`entity cache: ${Object.keys(cache).length}/${allCards.length} cached; extracting ${todoCards.length} via ${MODEL} (concurrency ${CONCURRENCY})`);
	let done = 0;
	await pool(todoCards, CONCURRENCY, (name) => {
		const raw = readFileSync(join(folderDir, name), "utf8");
		const fm = raw.match(/^---\n([\s\S]*?)\n---/);
		const title = fm?.[1].match(/^title:\s*"?([^\n"]+)"?/m)?.[1] ?? name.replace(/\.md$/, "");
		const body = raw.slice(fm?.[0].length ?? 0);
		return extractEntities(name, title, body).then((ents) => {
			cache[name] = ents;
			done++;
			if (done % 25 === 0) { writeFileSync(ENTITIES_CACHE, JSON.stringify(cache, null, 2)); console.log(`  ...${done}/${todoCards.length} (cache checkpoint)`); }
		}).catch((e) => { cache[name] = []; console.log(`  ✗ ${name}: ${e.message}`); });
	});
	writeFileSync(ENTITIES_CACHE, JSON.stringify(cache, null, 2));
	const totalEntities = Object.values(cache).reduce((s, e) => s + e.length, 0);
	console.log(`extracted ${totalEntities} entities across ${allCards.length} cards (${(totalEntities / allCards.length).toFixed(1)} avg/card)\n`);

	// ── 2. entity → cards inverted index (normalized name) ────────────────────
	const entityToCards = new Map();
	for (const name of allCards) for (const e of cache[name] ?? []) {
		if (!entityToCards.has(e.name)) entityToCards.set(e.name, new Set());
		entityToCards.get(e.name).add(name);
	}

	// ── 3 + 4. retrieval + measure ───────────────────────────────────────────
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));
	const queries = evalSet.queries;
	const setRecall = Object.fromEntries(KS.map((k) => [k, 0]));
	const setRecallEnt = Object.fromEntries(KS.map((k) => [k, 0]));
	const fullRecall = Object.fromEntries(KS.map((k) => [k, 0]));
	const fullRecallEnt = Object.fromEntries(KS.map((k) => [k, 0]));
	const perQuery = [];

	for (let i = 0; i < queries.length; i++) {
		const item = queries[i];
		const tags = queryToTags(item.q);
		const res = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags, topK: 60 });
		const ranked = rankWith(res.cards, true); // baseline tag-rank
		const expected = item.expect;

		// ENTITY EXPAND: seeds = tag-rank top-S; their entities; expand over FULL index.
		const seeds = ranked.slice(0, SEED_COUNT);
		const seedEntitySet = new Set();
		for (const s of seeds) for (const e of cache[s.path.split("/").pop()] ?? []) seedEntitySet.add(e.name);
		// expansion candidates: any card sharing an entity with a seed (by filename)
		const expCardsByFile = new Set();
		for (const en of seedEntitySet) for (const f of entityToCards.get(en) ?? []) expCardsByFile.add(f);
		// build entity-overlap score per file = #entities shared with seeds
		const entOverlap = new Map();
		for (const f of expCardsByFile) {
			const ents = (cache[f] ?? []).map((e) => e.name);
			let ov = 0; for (const e of ents) if (seedEntitySet.has(e)) ov++;
			entOverlap.set(f, ov);
		}
		// merged candidate set: tag-pool cards (have sharedTags) + expansion files.
		// score = sharedTags + entitySharedWithSeeds. Map files→pool-card for matched-check.
		const poolByName = new Map();
		for (const c of res.cards) poolByName.set(c.path.split("/").pop(), c);
		const merged = [];
		for (const f of new Set([...poolByName.keys(), ...expCardsByFile])) {
			const c = poolByName.get(f); // may be undefined (expansion-only card, no tag match)
			const sharedTags = c?.sharedTags ?? 0;
			const ent = entOverlap.get(f) ?? 0;
			merged.push({ file: f, sharedTags, ent, score: sharedTags + ent, mock: { path: `${FOLDER}/${f}`, id: c?.id ?? f.replace(/\.md$/, ""), title: c?.title ?? f.replace(/\.md$/, ""), sharedTags, hasCallouts: c?.hasCallouts ?? false } });
		}
		merged.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
		const entRanked = merged.map((m) => m.mock);

		for (const k of KS) {
			const topk = ranked.slice(0, k);
			const topkE = entRanked.slice(0, k);
			const found = expected.filter((e) => topk.some((c) => cardMatches(c, e)));
			const foundE = expected.filter((e) => topkE.some((c) => cardMatches(c, e)));
			setRecall[k] += found.length / expected.length;
			setRecallEnt[k] += foundE.length / expected.length;
			fullRecall[k] += found.length === expected.length ? 1 : 0;
			fullRecallEnt[k] += foundE.length === expected.length ? 1 : 0;
		}
		perQuery.push({ q: item.q.slice(0, 60), bridge: item.bridge, seedEntities: seedEntitySet.size, expCandidates: expCardsByFile.size });
		const tag = `[${String(i + 1).padStart(2, "0")}/${queries.length}]`;
		console.log(`${tag} bridge=${item.bridge.padEnd(12)} seedEnt=${seedEntitySet.size} expCands=${expCardsByFile.size}`);
	}

	const n = queries.length;
	const metrics = {};
	for (const k of KS) {
		metrics[`setRecall@${k}`] = { tag: setRecall[k] / n, entity: setRecallEnt[k] / n, delta: (setRecallEnt[k] - setRecall[k]) / n };
		metrics[`fullRecall@${k}`] = { tag: fullRecall[k] / n, entity: fullRecallEnt[k] / n, delta: (fullRecallEnt[k] - fullRecall[k]) / n };
	}
	const d4 = metrics["setRecall@4"].delta;
	const verdict = d4 >= 0.10 ? `→ ENTITY LAYER WINS (ΔsetRecall@4=+${d4.toFixed(3)} ≥ +0.10) → SHIP: persist entities frontmatter + port expansion to retrieve.ts`
		: d4 > 0 ? `→ ENTITY positive but < gate (+0.10): keep as opt-in candidate, do NOT change default`
		: `→ ENTITY neutral/negative → RETIRE`;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const receipt = { timestamp: new Date().toISOString(), model: MODEL, seeds: SEED_COUNT, baselineGate: "setRecall@4 >= +0.10 vs 0.567", totalEntities, entityToCardsSize: entityToCards.size, metrics, verdict, perQuery };
	writeFileSync(join(OUT_DIR, `measure-${ts}.json`), JSON.stringify(receipt, null, 2));

	console.log(`\n=== TRACK 3.3 ENTITY LAYER MEASURE (receipt) ===`);
	for (const k of KS) console.log(`  setRecall@${k}  tag=${metrics[`setRecall@${k}`].tag.toFixed(3)}  entity=${metrics[`setRecall@${k}`].entity.toFixed(3)}  Δ=${(metrics[`setRecall@${k}`].delta >= 0 ? "+" : "")}${metrics[`setRecall@${k}`].delta.toFixed(3)}`);
	console.log(`  fullRecall@4 tag=${metrics["fullRecall@4"].tag.toFixed(3)} entity=${metrics["fullRecall@4"].entity.toFixed(3)} Δ=${(metrics["fullRecall@4"].delta >= 0 ? "+" : "")}${metrics["fullRecall@4"].delta.toFixed(3)}`);
	console.log(`\n  ${verdict}`);
	console.log(`\nentities cache: ${ENTITIES_CACHE}\nreceipt: ${join(OUT_DIR, `measure-${ts}.json`)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
