#!/usr/bin/env bun
// scripts/hier-english-eval.mjs — ticket 09 (kcard-parity D23) English-set arm.
//
// Runs the D3 eval set (scripts/real-retrieval-eval.json, 50 questions, hit@4
// — the two-sided eval context-lifecycle D3 used alongside the recall-audit
// battery) through THREE retrieval arms so the default-switch decision sees
// both batteries, not just the 20-question natural-language one:
//
//   kcard             — flat retrieveRecords blend (the incumbent default)
//   kcard-hier        — hierarchicalRetrieve over the SurrealDB card index
//   kcard-flat-vector — pure KNN over the same index (D23 ablation arm)
//
// This is the live on-demand gate (D26): needs LM Studio bge-m3 + local
// SurrealDB. Receipt → output/hier-english-eval/receipt-<ts>.json.
//
// Run: bun scripts/hier-english-eval.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const K = 4;
const FOLDER = "Zettelkasten/knowledge-graph";

const { retrieveRecords } = await import("../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts");
const { hierarchicalRetrieve } = await import("../bun-apps/s2-agent-ext-knowledge-card/src/hierarchical-retrieval.ts");
const { makeContextClient, rebuildCardIndex } = await import("../bun-apps/s2-agent-ext-knowledge-card/src/surreal-index.ts");
const { embedQuery } = await import("../bun-apps/s2-agent-ext-knowledge-card/src/semantic.ts");
const { q2t } = await import("./recall-eval-harness.mjs");

// Explicit path (recall-audit.mjs pattern): resolveVault(process.cwd()) is
// cwd/config-dependent — measured resolving to an UNRELATED vault
// (study-news) when run from the repo root, silently building a 1-card index.
const vault = resolve(import.meta.dir, "..", "vaults_root", "s2-agent-vault");
const queries = JSON.parse(readFileSync(resolve(import.meta.dir, "real-retrieval-eval.json"), "utf8")).queries;

const client = makeContextClient({ endpoint: "http://127.0.0.1:8000", requestTimeoutMs: 60_000 });
const build = await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER });

const cardMatches = (c, expect) => `${c.path ?? ""} ${c.stem ?? c.id ?? ""} ${c.title ?? ""}`.toLowerCase().includes(expect.toLowerCase());

const ARMS = {
	kcard: async (q) => (await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: q2t(q), queryText: q, topK: K, bodyMatch: true, slugDom: true, semantic: true })).cards,
	"kcard-hier": async (q) => (await hierarchicalRetrieve(client, { query: q, topK: K })).cards,
	"kcard-flat-vector": async (q) => {
		const qv = await embedQuery(q);
		if (!qv) return [];
		const rows = await client.query(`SELECT stem, path, title, is_leaf FROM card WHERE vec <|${K + 20},100|> $qv;`, { qv });
		return (rows ?? []).filter((r) => r.is_leaf);
	},
};

const receipt = { ranAt: new Date().toISOString(), k: K, vault, index: { leaves: build.leafCount, aggs: build.aggCount, model: build.embedModel, skipped: build.skipped }, arms: {} };
for (const [label, run] of Object.entries(ARMS)) {
	let hits = 0;
	const perQuery = [];
	for (const { q, expect } of queries) {
		const cards = await run(q);
		const hit = cards.slice(0, K).some((c) => cardMatches(c, expect));
		if (hit) hits++;
		perQuery.push({ q, expect, hit, top1: cards[0] ? `${cards[0].stem ?? cards[0].id} :: ${cards[0].path ?? ""}` : "(none)" });
	}
	receipt.arms[label] = { hits, n: queries.length, rate: Number((hits / queries.length).toFixed(3)), perQuery };
}

const dir = resolve(import.meta.dir, "..", "output", "hier-english-eval");
mkdirSync(dir, { recursive: true });
const out = resolve(dir, `receipt-${receipt.ranAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");

console.log("=== HIER ENGLISH EVAL (ticket 09 D23, hit@4, n=50) ===");
for (const [label, r] of Object.entries(receipt.arms)) console.log(`${label.padEnd(18)} ${r.hits}/${r.n} (${r.rate})`);
console.log(`receipt: ${out}`);
