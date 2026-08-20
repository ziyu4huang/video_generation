#!/usr/bin/env node
// @ts-nocheck
/**
 * multi-hop-vector-measure.mjs — Track 3.4 VECTOR recall measure.
 *
 * LEGITIMATE REGIME RE-OPEN: the iter-7 suppression rule bars re-measuring
 * semantic on the SAME regime; nomic-embed-text-v1.5 (768-dim) is a DIFFERENT
 * model than vault-mind's all-MiniLM-L6-v2 (384-dim), so this is a valid new
 * regime. Plus: embeddings are CHEAP (ms, no reasoning) — unlike the 76-min
 * gemma entity extraction. SAG idea ④ caps the vector-model lever at ~+1.7pts,
 * so this is expected to be small, but it's the last lever and the number decides.
 *
 * WHAT THIS MEASURES (deterministic, reproducible):
 *   1. Embed every card (title + body, truncated) via nomic. Cached.
 *   2. Embed each multi-hop query.
 *   3. Cosine-rank cards by query similarity. Score setRecall@4 / fullRecall@4.
 *   4. Also a HYBRID: tag-sharedScore + α·cosine (the realistic deployment).
 *
 * GATE: vector setRecall@4 (or hybrid) must beat the tag baseline 0.567 by
 * >=+0.10 to ship; else retire (expected per SAG's +1.7pt cap).
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";

const REPO = process.cwd();
const FOLDER = "Zettelkasten/knowledge-graph";
const EVAL_FILE = join(REPO, "scripts/multi-hop-eval.json");
const OUT_DIR = join(REPO, "output/multi-hop-vector-measurements");
const EMB_CACHE = join(OUT_DIR, "embeddings.json");
const EMB_URL = process.env.EMB_URL ?? "http://127.0.0.1:1234/v1/embeddings";
const MODEL = process.env.EMB_MODEL ?? "text-embedding-nomic-embed-text-v1.5";
const KS = [4, 8, 16];
const HYBRID_ALPHA = 0.5; // hybrid = tagScore + alpha*normalizedCosine (cosine ~0.3-0.6, tag ~0-3)

function queryToTags(q) { return q.toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim().split(/\s+/).filter((t) => t.length >= 3 && t.length <= 30).slice(0, 10); }
function cardMatches(c, expect) { return `${c.path} ${c.id} ${c.title}`.toLowerCase().includes(expect.toLowerCase()); }
function cosine(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1); }

async function embedBatch(texts) {
	const res = await fetch(EMB_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, input: texts }), signal: AbortSignal.timeout(120_000) });
	if (!res.ok) throw new Error(`embed ${res.status}`);
	const data = await res.json();
	return data.data.map((d) => d.embedding);
}

async function main() {
	const vault = (await resolveVault(REPO)).path;
	mkdirSync(OUT_DIR, { recursive: true });
	const folderDir = join(vault, FOLDER);
	const allCards = readdirSync(folderDir).filter((n) => n.endsWith(".md"));

	// 1. embed all cards (cache)
	let cache = existsSync(EMB_CACHE) ? JSON.parse(readFileSync(EMB_CACHE, "utf8") || "{}") : {};
	const todo = allCards.filter((n) => !cache[n]);
	console.log(`embeddings: ${Object.keys(cache).length}/${allCards.length} cached; embedding ${todo.length} via ${MODEL}`);
	for (let i = 0; i < todo.length; i += 32) {
		const batch = todo.slice(i, i + 32);
		const texts = batch.map((n) => {
			const raw = readFileSync(join(folderDir, n), "utf8");
			const fm = raw.match(/^---\n([\s\S]*?)\n---/);
			const title = fm?.[1].match(/^title:\s*"?([^\n"]+)"?/m)?.[1] ?? n.replace(/\.md$/, "");
			return `${title}\n${raw.slice(fm?.[0].length ?? 0).slice(0, 600)}`;
		});
		const embs = await embedBatch(texts);
		batch.forEach((n, j) => { cache[n] = embs[j]; });
		writeFileSync(EMB_CACHE, JSON.stringify(cache));
		if ((i / 32) % 2 === 0) console.log(`  ...${i + batch.length}/${todo.length}`);
	}

	// 2. embed queries
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));
	const queryEmbs = await embedBatch(evalSet.queries.map((q) => q.q));

	// precompute card embedding list
	const cardFiles = Object.keys(cache);
	const cardEmbArr = cardFiles.map((n) => cache[n]);

	const setRecallTag = Object.fromEntries(KS.map((k) => [k, 0]));
	const setRecallVec = Object.fromEntries(KS.map((k) => [k, 0]));
	const setRecallHyb = Object.fromEntries(KS.map((k) => [k, 0]));
	const perQuery = [];

	for (let qi = 0; qi < evalSet.queries.length; qi++) {
		const item = evalSet.queries[qi];
		const expected = item.expect;
		const qe = queryEmbs[qi];

		// vector rank (over ALL cards)
		const sims = cardEmbArr.map((e, idx) => ({ file: cardFiles[idx], cos: cosine(qe, e) }));
		sims.sort((a, b) => b.cos - a.cos);

		// tag rank (retrieveRecords)
		const tags = queryToTags(item.q);
		const res = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags, topK: 60 });
		const tagRanked = res.cards.map((c) => ({ file: c.path.split("/").pop(), c, sharedTags: c.sharedTags }));
		const tagByName = new Map(tagRanked.map((x) => [x.file, x]));

		// hybrid: combine tag sharedTags + alpha*normCos. normalize cos to 0..1 roughly (cos in ~0.2..0.6)
		const cosByName = new Map(sims.map((x) => [x.file, x.cos]));
		const cosVals = sims.map((x) => x.cos);
		const cosMax = Math.max(...cosVals), cosMin = Math.min(...cosVals);
		const normCos = (c) => (cosMax === cosMin ? 1 : (c - cosMin) / (cosMax - cosMin));
		const hybPool = new Set([...tagByName.keys(), ...cosByName.keys()]);
		const hyb = [...hybPool].map((f) => {
			const t = tagByName.get(f);
			const tag = t?.sharedTags ?? 0;
			const cos = cosByName.get(f) ?? 0;
			return { file: f, score: tag + HYBRID_ALPHA * normCos(cos) * 3, tag, cos };
		});
		hyb.sort((a, b) => b.score - a.score);

		const mock = (file) => ({ path: `${FOLDER}/${file}`, id: file.replace(/\.md$/, ""), title: file.replace(/\.md$/, ""), sharedTags: 0, hasCallouts: false });
		for (const k of KS) {
			const topTag = tagRanked.slice(0, k).map((x) => x.c);
			const topVec = sims.slice(0, k).map((x) => mock(x.file));
			const topHyb = hyb.slice(0, k).map((x) => mock(x.file));
			const fTag = expected.filter((e) => topTag.some((c) => cardMatches(c, e)));
			const fVec = expected.filter((e) => topVec.some((c) => cardMatches(c, e)));
			const fHyb = expected.filter((e) => topHyb.some((c) => cardMatches(c, e)));
			setRecallTag[k] += fTag.length / expected.length;
			setRecallVec[k] += fVec.length / expected.length;
			setRecallHyb[k] += fHyb.length / expected.length;
		}
		// ranks of expected under each mode
		const rankOf = (arr, e) => { const i = arr.findIndex((x) => (x.file ?? x.c?.path?.split("/").pop()).toLowerCase().includes(e.toLowerCase()) || `${FOLDER}/${x.file}`.toLowerCase().includes(e.toLowerCase())); return i < 0 ? null : i + 1; };
		perQuery.push({ bridge: item.bridge, vecRanks: expected.map((e) => rankOf(sims, e)) });
		console.log(`[${String(qi + 1).padStart(2, "0")}/${evalSet.queries.length}] ${item.bridge.padEnd(12)} vecRanks=${JSON.stringify(perQuery[qi].vecRanks)}`);
	}

	const n = evalSet.queries.length;
	const m = {};
	for (const k of KS) m[`@${k}`] = { tag: setRecallTag[k] / n, vector: setRecallVec[k] / n, hybrid: setRecallHyb[k] / n, vecDelta: (setRecallVec[k] - setRecallTag[k]) / n, hybDelta: (setRecallHyb[k] - setRecallTag[k]) / n };
	const d4vec = m["@4"].vecDelta, d4hyb = m["@4"].hybDelta;
	const verdict = (Math.max(d4vec, d4hyb) >= 0.10)
		? `→ VECTORS WIN (vec Δ=+${d4vec.toFixed(3)}, hyb Δ=+${d4hyb.toFixed(3)} ≥ +0.10) → re-open semantic; ship a vector/hybrid path`
		: `→ VECTORS do NOT clear +0.10 (vec Δ=${d4vec.toFixed(3)}, hyb Δ=${d4hyb.toFixed(3)}) → RETIRE (consistent with SAG's +1.7pt cap + iter-7)`;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const receipt = { timestamp: new Date().toISOString(), model: MODEL, hybridAlpha: HYBRID_ALPHA, metrics: m, verdict, perQuery };
	writeFileSync(join(OUT_DIR, `measure-${ts}.json`), JSON.stringify(receipt, null, 2));

	console.log(`\n=== TRACK 3.4 VECTOR MEASURE (nomic, ${MODEL}) ===`);
	for (const k of KS) console.log(`  setRecall${k}  tag=${m[`@${k}`].tag.toFixed(3)}  vector=${m[`@${k}`].vector.toFixed(3)}(Δ${(m[`@${k}`].vecDelta >= 0 ? "+" : "")}${m[`@${k}`].vecDelta.toFixed(3)})  hybrid=${m[`@${k}`].hybrid.toFixed(3)}(Δ${(m[`@${k}`].hybDelta >= 0 ? "+" : "")}${m[`@${k}`].hybDelta.toFixed(3)})`);
	console.log(`\n  ${verdict}`);
	console.log(`\nreceipt: ${join(OUT_DIR, `measure-${ts}.json`)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
