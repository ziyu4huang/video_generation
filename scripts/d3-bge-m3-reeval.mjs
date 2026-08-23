#!/usr/bin/env bun
// scripts/d3-bge-m3-reeval.mjs — D3 eval gate (context-lifecycle ticket 07).
//
// Re-measures the shipped semantic-blend hit@4 on the committed eval set
// (scripts/real-retrieval-eval.json) under BOTH embedders, live, on the SAME
// corpus + eval set, so the D3 decision (canonical = BGE-M3, ticket 01) is an
// apples-to-apples A/B rather than a comparison against a number recorded on
// a smaller/older corpus:
//
//   arm nomic  — semantic blend, model text-embedding-nomic-embed-text-v1.5
//                (the 2026-07 measured 0.84 → 1.00 blend's embedder)
//   arm bge-m3 — semantic blend, model text-embedding-bge-m3 (ticket 01's
//                canonical; the CURRENT SEMANTIC_MODEL_DEFAULT)
//
// GATE (spec D3): bge-m3 hit@4 must be >= nomic's on the same run, on both
// the full set and the first-25 slice (where the recorded nomic 1.00 lived).
// If it drops, D3 flips back to nomic and the numbers are recorded in the
// effort map Context. Each arm runs through the faithful harness (runGate),
// whose drift-guard (first-25 lexical = 21/25 = 0.84) aborts a broken
// measurement before it is trusted.
//
// Run: bun scripts/d3-bge-m3-reeval.mjs
// Receipt: output/d3-reeval/receipt-<ts>.json
import { runGate, q2t } from "./recall-eval-harness.mjs";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MODELS = {
	nomic: "text-embedding-nomic-embed-text-v1.5",
	"bge-m3": "text-embedding-bge-m3",
};

const FOLDER = "Zettelkasten/knowledge-graph";
const semanticArm = (vault, model) => async (q) =>
	(
		await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: q2t(q),
			queryText: q,
			topK: 4,
			bodyMatch: true,
			slugDom: true,
			semantic: true,
			semanticModel: model,
		})
	).cards;

const { resolveVault } = await import("../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts");
const vault = (await resolveVault(process.cwd())).path;

const receipt = { ranAt: new Date().toISOString(), vault, arms: {} };
for (const [label, model] of Object.entries(MODELS)) {
	const gate = await runGate({
		label: `D3 re-eval — semantic blend under ${model}`,
		candidateRetrieve: semanticArm(vault, model),
	});
	const first25 = (gate.cand?.perQuery ?? []).filter((p) => p.i < 25);
	receipt.arms[label] = {
		model,
		driftOk: gate.driftOk,
		aborted: gate.aborted ?? false,
		hits: gate.cand?.hits ?? null,
		n: gate.cand?.n ?? null,
		rate: gate.cand?.rate ?? null,
		hitIdx: (gate.cand?.perQuery ?? []).filter((p) => p.hit).map((p) => p.i),
		first25: {
			hits: first25.filter((p) => p.hit).length,
			n: first25.length,
		},
		base: gate.base ? { hits: gate.base.hits, n: gate.base.n, rate: gate.base.rate } : null,
		lost: gate.lost ?? [],
		gained: gate.gained ?? [],
	};
}

const dir = resolve(import.meta.dir, "..", "output", "d3-reeval");
mkdirSync(dir, { recursive: true });
const out = resolve(dir, `receipt-${receipt.ranAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");

const nomic = receipt.arms.nomic;
const bge = receipt.arms["bge-m3"];
console.log("\n=== D3 EVAL GATE (ticket 07) ===");
console.log(`nomic:  full ${nomic.hits}/${nomic.n} (${(nomic.rate ?? 0).toFixed(2)})  first-25 ${nomic.first25.hits}/${nomic.first25.n}`);
console.log(`bge-m3: full ${bge.hits}/${bge.n} (${(bge.rate ?? 0).toFixed(2)})  first-25 ${bge.first25.hits}/${bge.first25.n}`);
const gatePass =
	!bge.aborted && bge.rate >= nomic.rate && bge.first25.hits >= nomic.first25.hits;
console.log(
	`gate: bge-m3 >= nomic (full + first-25) → ${gatePass ? "PASS (D3 holds)" : "FAIL (D3 flips back to nomic — record numbers in map)"}`,
);
console.log(`receipt: ${out}`);
