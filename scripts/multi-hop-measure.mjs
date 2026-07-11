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
import { resolveVault } from "../bun-apps/pi-agent-ext-obsidian/extensions/obsidian.ts";
import { retrieveRecords } from "../bun-apps/pi-agent-ext-knowledge-card/src/retrieve.ts";
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

async function main() {
	const vault = (await resolveVault(REPO)).path;
	if (!existsSync(EVAL_FILE)) { console.error(`eval set not found: ${EVAL_FILE}`); process.exit(1); }
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));
	const queries = evalSet.queries;
	mkdirSync(OUT_DIR, { recursive: true });

	const perQuery = [];
	// accumulators per K
	const setRecall = Object.fromEntries(KS.map((k) => [k, 0]));
	const fullRecall = Object.fromEntries(KS.map((k) => [k, 0]));
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

		const row = { q: item.q.slice(0, 64), bridge: item.bridge, expected, expSources, tags };

		for (const k of KS) {
			const topk = ranked.slice(0, k);
			const found = expected.filter((e) => topk.some((c) => cardMatches(c, e)));
			const foundSources = [...new Set(item.sources.filter((_, idx) => topk.some((c) => cardMatches(c, expected[idx]))))];
			const recall = found.length / expected.length;
			setRecall[k] += recall;
			fullRecall[k] += found.length === expected.length ? 1 : 0;
			sourceCov[k] += foundSources.length / expSources.length;
			row[`found@${k}`] = found;
			row[`setRecall@${k}`] = recall;
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
		metrics[`fullRecall@${k}`] = { value: fullRecall[k] / n, raw: `${fullRecall[k]}/${n}`, note: "fraction of queries where ALL expected cards surfaced" };
		metrics[`sourceCoverage@${k}`] = { value: sourceCov[k] / n, raw: `${sourceCov[k].toFixed(2)}/${n}`, note: "mean distinct expected sources reached in top-K" };
	}
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
	console.log(`\nreceipt: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
