// scripts/recall-eval-harness.mjs
// Faithful recall-eval harness — the "correct gate method" for regime-change probes.
//
// LESSON (from knowledge-extraction-tag-coverage iter): an UNFAITHFUL Phase-2 gate
// that REPLICATED retrieve.ts scoring (wrong stop sets) produced a false +0.08 signal
// because its drift-guard baseline measured 0.80, not the shipped 0.84. The faithful
// Phase-4 gate (real retrieveRecords, reproduced 0.84) found the truth (net-zero recall).
//
// THEREFORE this harness:
//   1. imports the REAL retrieveRecords (never re-implements scoring);
//   2. runs a MANDATORY drift-guard whose baseline MUST reproduce the shipped 0.84
//      (21/25, bodyMatch+slugDom, original tags) — if it doesn't, the harness ABORTS
//      the candidate (no measurement is trusted under a broken baseline);
//   3. enforces zero-regression (candidate must not lose any of the 21 baseline hits);
//   4. reports gained/lost + per-query latency so ship decisions are evidence-backed.
//
// The candidate is a pluggable async `retrieve(query, idx) -> {cards}` hook, so every
// regime (A query-expansion / B semantic-seed / C rerank) runs through the SAME gate
// and deltas are directly comparable.
//
// Usage as a module (probes import {runGate}):
//   import { runGate } from "./scripts/recall-eval-harness.mjs";
//   await runGate({ label: "Probe A", candidateRetrieve: myRetrieve });
//
// Usage as a CLI self-test (no candidate — verifies the drift-guard alone):
//   bun scripts/recall-eval-harness.mjs

import { retrieveRecords } from "../bun-apps/pi-agent-ext-knowledge-card/src/retrieve.ts";
import { resolveVault } from "../bun-apps/pi-agent-ext-obsidian/extensions/obsidian.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const EVAL_PATH = resolve(REPO, "scripts/real-retrieval-eval.json");
const FOLDER = "Zettelkasten/knowledge-graph";
const SHIPPED_BASELINE_RATE = 0.84; // drift-guard target — #486 bodyMatch + #492 slugDom
const SHIPPED_BASELINE_HITS = 21; // 21/25
const SHIP_RECALL_RATE = 0.88; // a regime must reach ≥0.88 to be a candidate ship

// Tag tokenization — must match retrieve.ts's tag expectation (len 3-30, slug-ish).
export const q2t = (q) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 30)
    .slice(0, 10);

// A card matches the expected substring against id / path / title (case-insensitive).
const cardMatches = (c, expect) =>
  `${c.path} ${c.id} ${c.title}`.toLowerCase().includes(expect.toLowerCase());

const evalQueries = JSON.parse(readFileSync(EVAL_PATH, "utf8")).queries;

// Run the 25-query eval through a `retrieve(query, idx) -> {cards}` hook.
async function evalRetrieve(retrieve) {
  let hits = 0;
  const hitIdx = [];
  const perQuery = [];
  for (let i = 0; i < evalQueries.length; i++) {
    const t0 = Date.now();
    const cards = await retrieve(evalQueries[i].q, i);
    const lat = Date.now() - t0;
    const hit = Array.isArray(cards) && cards.some((c) => cardMatches(c, evalQueries[i].expect));
    if (hit) {
      hits++;
      hitIdx.push(i);
    }
    perQuery.push({ i, q: evalQueries[i].q, expect: evalQueries[i].expect, hit, lat });
  }
  return { hits, rate: hits / evalQueries.length, hitIdx, perQuery };
}

// Baseline retrieve = the SHIPPED path (bodyMatch + slugDom, original query tags).
// This is the drift-guard target. Any candidate is measured AGAINST this.
const baselineRetrieve = (vault) => async (q) =>
  (
    await retrieveRecords({
      vaultPath: vault,
      folder: FOLDER,
      tags: q2t(q),
      topK: 4,
      bodyMatch: true,
      slugDom: true,
    })
  ).cards;

/**
 * Run the faithful gate for a candidate regime.
 * @param {object} opts
 * @param {string} opts.label - regime label for the report
 * @param {(query:string, idx:number) => Promise<{path,id,title}[]>} opts.candidateRetrieve
 *        - the regime's retrieve hook (expanded tags / semantic seed / rerank)
 * @param {object} [opts.cost] - optional {latencyMsP95, tokensPerQuery} cost summary
 * @returns gate result object with driftOk / zeroRegress / recallOk / pass
 */
export async function runGate({ label, candidateRetrieve, cost }) {
  const vault = (await resolveVault(REPO)).path;

  // 1. MANDATORY drift-guard — baseline must reproduce the shipped 0.84.
  const base = await evalRetrieve(baselineRetrieve(vault));
  const driftOk = base.hits === SHIPPED_BASELINE_HITS && base.rate === SHIPPED_BASELINE_RATE;
  console.log(
    `DRIFT-GUARD [baseline bodyMatch+slugDom]: ${base.hits}/25 (${base.rate.toFixed(2)}) ` +
      `${driftOk ? "✓ reproduces shipped 0.84" : "✗ BROKEN (expected 21/25=0.84) — ABORT"}`,
  );
  if (!driftOk) {
    console.log("❌ ABORT: drift-guard failed — candidate measurement is UNTRUSTWORTHY.");
    return { label, driftOk: false, aborted: true };
  }

  // 2. Candidate eval.
  const cand = await evalRetrieve(candidateRetrieve);
  const gained = [],
    lost = [];
  for (let i = 0; i < evalQueries.length; i++) {
    const a = base.hitIdx.includes(i);
    const b = cand.hitIdx.includes(i);
    if (b && !a) gained.push(evalQueries[i].expect);
    if (a && !b) lost.push(evalQueries[i].expect);
  }
  const zeroRegress = lost.length === 0;
  const recallOk = cand.rate >= SHIP_RECALL_RATE;

  // 3. Report.
  const avgLat = Math.round(cand.perQuery.reduce((s, p) => s + p.lat, 0) / cand.perQuery.length);
  console.log(`CANDIDATE [${label}]: ${cand.hits}/25 (${cand.rate.toFixed(2)})  avg ${avgLat}ms/q`);
  console.log(
    `Δ=${(cand.rate - base.rate >= 0 ? "+" : "")}${(cand.rate - base.rate).toFixed(3)}  ` +
      `gained:[${gained.join(", ") || "none"}]  lost:[${lost.join(", ") || "none"}]`,
  );
  if (cost) console.log(`COST: ${JSON.stringify(cost)}`);
  console.log(
    `GATE: drift=✓ zero-regress=${zeroRegress ? "✓" : "✗"} recall≥0.88=${recallOk ? "✓" : "✗"} ` +
      `→ ${driftOk && zeroRegress && recallOk ? "✅ PASS — candidate ship" : "❌ no ship (record finding)"}`,
  );

  return { label, driftOk, base, cand, gained, lost, zeroRegress, recallOk, pass: driftOk && zeroRegress && recallOk, cost };
}

// CLI self-test: verify the drift-guard alone reproduces 0.84 (harness health check).
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("=== recall-eval-harness self-test (drift-guard only) ===");
  const vault = (await resolveVault(REPO)).path;
  const base = await evalRetrieve(baselineRetrieve(vault));
  const ok = base.hits === SHIPPED_BASELINE_HITS && base.rate === SHIPPED_BASELINE_RATE;
  console.log(`baseline: ${base.hits}/25 (${base.rate.toFixed(2)})  ${ok ? "✅ harness healthy (drift-guard reproduces 0.84)" : "❌ harness BROKEN"}`);
  process.exit(ok ? 0 : 1);
}
