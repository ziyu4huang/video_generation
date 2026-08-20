#!/usr/bin/env node
// @ts-nocheck
/**
 * multi-hop-measure.mjs — DETERMINISTIC multi-hop / cross-source retrieval
 * measurement (Track 2 of the memory-orchestration cycle).
 *
 * WHAT THIS MEASURES (all deterministic, no LLM, no model noise — reproducible ±0)
 *   For each multi-hop query in scripts/multi-hop-eval.json (each expects >=2
 *   cards across >=2 sources, bridged by a shared concept tag):
 *     1. Tokenize the query into tags (identical to knowledge_query's inference).
 *     2. retrieveRecords(tags, topK=60) — the deterministic tag-path retrieval.
 *     3. Rank by sharedTags (+ callout boost), then check at K ∈ {4, 8, 16} how
 *        many of the EXPECTED cards surfaced.
 *
 * METRICS (the multi-hop RULER — Track 3 must beat these by >=+0.10 to ship)
 *   A. setRecall@K   — over all queries, mean of (expected cards found in top-K)
 *                      / (total expected for that query). A single-hop retriever
 *                      finds the 1st expected card (query-token match); the 2nd
 *                      (bridged only by a shared tag) is the multi-hop signal.
 *                      setRecall@4 < 0.5 means the 2nd card rarely makes top-4.
 *   B. fullRecall@K  — fraction of QUERIES where ALL expected cards surfaced in
 *                      top-K (the strict multi-hop success rate).
 *   C. sourceCoverage@K — mean over queries of (distinct expected SOURCES whose
 *                      card(s) surfaced in top-K) / (distinct expected sources).
 *                      Cross-source reach: does retrieval span provenance families?
 *   D. bridgeLift@K  — setRecall climbing from K=4 → K=8 → K=16. A steep climb
 *                      means the 2nd card IS in the candidate pool but ranked too
 *                      low — exactly what a rerank/entity layer could fix.
 *
 * OUTPUT: output/multi-hop-measurements/measure-<ts>.json (the receipt).
 *
 * HONEST DESIGN: this is the DETERMINISTIC baseline (retrieveRecords, no LLM).
 * It is the apples-to-apples, reproducible ruler. A companion LIVE mode
 * (zk_ask graph-RAG, non-deterministic) is documented in the receipt header but
 * NOT run here — it lives behind MULTI_HOP_LIVE=1 and shells to the live agent
 * (expensive, hours). The deterministic baseline is what gates Track 3: any
 * retrieval change is measured HERE first; the live run is a later confirmation.
 */
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const FOLDER = "Zettelkasten/knowledge-graph";
const EVAL_FILE = join(REPO, "scripts/multi-hop-eval.json");
const OUT_DIR = join(REPO, "output/multi-hop-measurements");
const KS = [4, 8, 16];
const CANDIDATE_POOL = 60; // wide retrieval so depth-K is meaningful

function queryToTags(q) {
	return q.toLowerCase()
		.replace(/[^a-z0-9-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((t) => t.length >= 3 && t.length <= 30)
		.slice(0, 10);
}

function rankWith(cards, boost) {
	const scored = cards.map((c) => ({
		c,
		s: c.sharedTags + (boost && c.hasCallouts ? 0.5 : 0),
	}));
	scored.sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
	return scored.map((x) => x.c);
}

function cardMatches(c, expect) {
	const hay = `${c.path} ${c.id} ${c.title}`.toLowerCase();
	return hay.includes(expect.toLowerCase());
}

// ── Track 3.1 ablation: lexical BM25-ish RERANK (no LLM, no vectors) ─────────
// SAG idea ② (the non-vector half): coarse-rank broadly (tag-sharedScore), then
// precision-RERANK the pool by query-token overlap with each card's title+body.
// The baseline showed some 2nd expected cards are in the pool but under-ranked
// (rank 8–44) — a rerank is the lever that could surface them. This ablation
// measures whether it actually does, BEFORE any production code change.
const STOP = new Set(["the","and","for","with","that","this","how","why","does","was","were","after","before","when","what","have","has","not","but","are","is","it","to","of","in","on","my","i","a","an","two","both","same","next","sit","also","gotcha","review","memory","auto"]);
const textCache = new Map();
function readCardText(vault, folder, c) {
	if (textCache.has(c.path)) return textCache.get(c.path);
	let body = "";
	try { body = readFileSync(join(vault, folder, c.path.split("/").pop()), "utf8").toLowerCase(); } catch { /* missing file */ }
	textCache.set(c.path, body);
	return body;
}
function bm25Score(queryTokens, text, title) {
	let s = 0;
	for (const t of queryTokens) {
		if (STOP.has(t)) continue;
		const titleHits = title.split(t).length - 1;
		const bodyHits = text.split(t).length - 1;
		if (titleHits) s += 3 * titleHits; // title boost (precision signal)
		if (bodyHits) s += Math.min(bodyHits, 5); // cap body tf
	}
	return s;
}

async function main() {
	const vault = (await resolveVault(REPO)).path;
	if (!existsSync(EVAL_FILE)) { console.error(`eval set not found: ${EVAL_FILE}`); process.exit(1); }
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));
	const queries = evalSet.queries;
	mkdirSync(OUT_DIR, { recursive: true });

	const perQuery = [];
	// accumulators per K
	const setRecall = Object.fromEntries(KS.map((k) => [k, 0]));
	const setRecallRR = Object.fromEntries(KS.map((k) => [k, 0]));
	const fullRecall = Object.fromEntries(KS.map((k) => [k, 0]));
	const fullRecallRR = Object.fromEntries(KS.map((k) => [k, 0]));
	const sourceCov = Object.fromEntries(KS.map((k) => [k, 0]));

	console.log(`multi-hop DETERMINISTIC measure: ${queries.length} queries | vault=${vault}`);
	console.log(`Ks=${KS.join(",")} | candidate pool=${CANDIDATE_POOL}\n`);

	for (let i = 0; i < queries.length; i++) {
		const item = queries[i];
		const tags = queryToTags(item.q);
		const res = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags, topK: CANDIDATE_POOL });
		const ranked = rankWith(res.cards, true);
		const expected = item.expect;
		const expSources = [...new Set(item.sources)];

		// RERANK: take the tag-ranked pool (top 30), re-score by lexical BM25-ish
		// overlap with the query tokens, re-rank. (Pool, not full vault — rerank is a
		// precision stage over the coarse-recall output, exactly SAG's pattern.)
		const pool = ranked.slice(0, 30);
		const qTokens = queryToTags(item.q);
		const reranked = pool
			.map((c) => ({ c, s: bm25Score(qTokens, readCardText(vault, FOLDER, c), `${c.id} ${c.title}`.toLowerCase()) }))
			.sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
			.map((x) => x.c);

		const row = { q: item.q.slice(0, 64), bridge: item.bridge, expected, expSources, tags };

		for (const k of KS) {
			const topk = ranked.slice(0, k);
			const topkRR = reranked.slice(0, k);
			const found = expected.filter((e) => topk.some((c) => cardMatches(c, e)));
			const foundRR = expected.filter((e) => topkRR.some((c) => cardMatches(c, e)));
			const foundSources = [...new Set(item.sources.filter((_, idx) => topk.some((c) => cardMatches(c, expected[idx]))))];
			const recall = found.length / expected.length;
			const recallRR = foundRR.length / expected.length;
			setRecall[k] += recall;
			setRecallRR[k] += recallRR;
			fullRecall[k] += found.length === expected.length ? 1 : 0;
			fullRecallRR[k] += foundRR.length === expected.length ? 1 : 0;
			sourceCov[k] += foundSources.length / expSources.length;
			row[`found@${k}`] = found;
			row[`setRecall@${k}`] = recall;
			row[`setRecallRR@${k}`] = recallRR;
		}
		// also record the rank position of each expected card (1-indexed) for the bridgeLift signal
		row.ranks = expected.map((e) => {
			const idx = ranked.findIndex((c) => cardMatches(c, e));
			return idx < 0 ? null : idx + 1;
		});
		perQuery.push(row);
		const tag = `[${String(i + 1).padStart(2, "0")}/${queries.length}]`;
		console.log(`${tag} bridge=${item.bridge.padEnd(12)} R@4=${row.setRecallAt4 ?? row["setRecall@4"]?.toFixed?.(2)} ranks=${JSON.stringify(row.ranks)}`);
	}

	const n = queries.length;
	const metrics = {};
	for (const k of KS) {
		metrics[`setRecall@${k}`] = { value: setRecall[k] / n, raw: `${setRecall[k].toFixed(2)}/${n}`, note: "mean (expected cards in top-K)/(total expected)" };
		metrics[`setRecallRR@${k}`] = { value: setRecallRR[k] / n, raw: `${setRecallRR[k].toFixed(2)}/${n}`, note: "Track 3.1 RERANK: same metric after lexical BM25 rerank of the pool" };
		metrics[`fullRecall@${k}`] = { value: fullRecall[k] / n, raw: `${fullRecall[k]}/${n}`, note: "fraction of queries where ALL expected cards surfaced" };
		metrics[`fullRecallRR@${k}`] = { value: fullRecallRR[k] / n, raw: `${fullRecallRR[k]}/${n}`, note: "RERANK: fraction of queries where ALL expected surfaced" };
		metrics[`sourceCoverage@${k}`] = { value: sourceCov[k] / n, raw: `${sourceCov[k].toFixed(2)}/${n}`, note: "mean distinct expected sources reached in top-K" };
	}
	const rerankDelta = {
		"setRecall@4": (setRecallRR[4] - setRecall[4]) / n,
		"fullRecall@4": (fullRecallRR[4] - fullRecall[4]) / n,
		gate: ">= +0.10 setRecall@4 to ship the rerank lever; else retire (iter-7 discipline)",
	};
	const bridgeLift = {
		from4to8: (setRecall[8] - setRecall[4]) / n,
		from8to16: (setRecall[16] - setRecall[8]) / n,
		note: "how much setRecall climbs as K deepens — a steep climb means the 2nd card is in the pool but under-ranked (rerank/entity lever).",
	};

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const receipt = {
		timestamp: new Date().toISOString(),
		mode: "deterministic (retrieveRecords, no LLM) — reproducible ±0",
		evalSet: EVAL_FILE,
		vault,
		folder: FOLDER,
		queries: n,
		candidatePool: CANDIDATE_POOL,
		KS,
		gate: "Track 3 levers must beat setRecall@4 by >=+0.10 to ship, else retire (iter-7 discipline).",
		liveModeNote: "A LIVE zk_ask run (graph-RAG, non-deterministic) can be added via a companion harness; not run here. The deterministic baseline is the reproducible gate.",
		metrics,
		bridgeLift,
		rerankDelta,
		perQuery,
	};
	const outPath = join(OUT_DIR, `measure-${ts}.json`);
	writeFileSync(outPath, JSON.stringify(receipt, null, 2));

	console.log("\n=== MULTI-HOP DETERMINISTIC BASELINE (receipt) ===");
	for (const k of KS) {
		console.log(`  setRecall@${k}       = ${metrics[`setRecall@${k}`].value.toFixed(3)}  (${metrics[`setRecall@${k}`].raw})`);
		console.log(`  fullRecall@${k}      = ${metrics[`fullRecall@${k}`].value.toFixed(3)}  (${metrics[`fullRecall@${k}`].raw})`);
		console.log(`  sourceCoverage@${k}  = ${metrics[`sourceCoverage@${k}`].value.toFixed(3)}`);
	}
	console.log(`\n  bridgeLift 4→8 = ${bridgeLift.from4to8.toFixed(3)} | 8→16 = ${bridgeLift.from8to16.toFixed(3)}`);
	console.log(`\n  ── Track 3.1 RERANK ablation (lexical BM25 over the pool) ──`);
	console.log(`  setRecall@4  baseline=${metrics.setRecallAt4 ?? metrics["setRecall@4"].value.toFixed(3)}  rerank=${metrics["setRecallRR@4"].value.toFixed(3)}  Δ=${rerankDelta["setRecall@4"] >= 0 ? "+" : ""}${rerankDelta["setRecall@4"].toFixed(3)}`);
	console.log(`  fullRecall@4 baseline=${metrics["fullRecall@4"].value.toFixed(3)}  rerank=${metrics["fullRecallRR@4"].value.toFixed(3)}  Δ=${rerankDelta["fullRecall@4"] >= 0 ? "+" : ""}${rerankDelta["fullRecall@4"].toFixed(3)}`);
	const rrVerdict = rerankDelta["setRecall@4"] >= 0.10
		? `→ RERANK WINS (Δ≥+0.10) → port to production retrieve.ts as opt-in`
		: rerankDelta["setRecall@4"] > 0
			? `→ RERANK positive but < gate (+0.10) → keep as opt-in diagnostic, do NOT change default`
			: `→ RERANK neutral/negative → RETIRE (lexical rerank doesn't help multi-hop); receipt logged`;
	console.log(rrVerdict);
	console.log(`\nreceipt: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
