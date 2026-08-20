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

import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const EVAL_PATH = resolve(REPO, "scripts/real-retrieval-eval.json");
const FOLDER = "Zettelkasten/knowledge-graph";
const DRIFT_GUARD_RATE = 0.84; // drift-guard target — #486 bodyMatch + #492 slugDom (lexical)
const DRIFT_GUARD_HITS = 21; // 21/25 on the ORIGINAL first-25 set
const DRIFT_GUARD_N = 25; // the original eval slice — harness integrity anchor
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

// Run a query slice [lo, hi) through a `retrieve(query, idx) -> {cards}` hook.
// Defaults to the full set. Slice is used by the drift-guard (first 25).
async function evalRetrieve(retrieve, lo = 0, hi = evalQueries.length) {
  let hits = 0;
  const hitIdx = [];
  const perQuery = [];
  for (let i = lo; i < hi; i++) {
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
  const n = hi - lo;
  return { hits, rate: hits / n, hitIdx, perQuery, n };
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

// Shipped semantic path (PR #510): opt-in semantic blend on top of lexical.
// Used by the Phase-A stress-test (does 1.00 hold at 50 queries?) + as the
// zero-regression reference for future candidates.
const shippedSemanticRetrieve = (vault) => async (q) =>
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

  // 1. MANDATORY drift-guard — first-25 lexical baseline must reproduce 0.84 (21/25).
  //    This is the harness-INTEGRITY anchor: if it breaks, no measurement is trusted.
  const guard = await evalRetrieve(baselineRetrieve(vault), 0, DRIFT_GUARD_N);
  const driftOk = guard.hits === DRIFT_GUARD_HITS && guard.rate === DRIFT_GUARD_RATE;
  console.log(
    `DRIFT-GUARD [first-25 lexical]: ${guard.hits}/${DRIFT_GUARD_N} (${guard.rate.toFixed(2)}) ` +
      `${driftOk ? "✓ reproduces shipped 0.84" : "✗ BROKEN (expected 21/25=0.84) — ABORT"}`,
  );
  if (!driftOk) {
    console.log("❌ ABORT: drift-guard failed — candidate measurement is UNTRUSTWORTHY.");
    return { label, driftOk: false, aborted: true };
  }

  // 2. Reference baseline on the FULL set (lexical) + candidate on the FULL set.
  const base = await evalRetrieve(baselineRetrieve(vault));
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
  console.log(`CANDIDATE [${label}]: ${cand.hits}/${evalQueries.length} (${cand.rate.toFixed(2)})  avg ${avgLat}ms/q`);
  console.log(
    `Δ-vs-lexical-full=${(cand.rate - base.rate >= 0 ? "+" : "")}${(cand.rate - base.rate).toFixed(3)}  ` +
      `gained:[${gained.join(", ") || "none"}]  lost:[${lost.join(", ") || "none"}]`,
  );
  if (cost) console.log(`COST: ${JSON.stringify(cost)}`);
  console.log(
    `GATE: drift=✓ zero-regress=${zeroRegress ? "✓" : "✗"} recall≥0.88=${recallOk ? "✓" : "✗"} ` +
      `→ ${driftOk && zeroRegress && recallOk ? "✅ PASS — candidate ship" : "❌ no ship (record finding)"}`,
  );

  return { label, driftOk, guard, base, cand, gained, lost, zeroRegress, recallOk, pass: driftOk && zeroRegress && recallOk, cost };
}

// CLI: Phase-A stress-test — drift-guard + lexical-vs-shipped-semantic on the FULL set.
// Answers: "does the shipped 1.00 (PR #510 semantic blend) hold at 50 queries?"
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`=== recall-eval-harness Phase-A stress-test (${evalQueries.length} queries) ===`);
  const vault = (await resolveVault(REPO)).path;

  // 1. Drift-guard on the original first-25 (lexical must reproduce 0.84).
  const guard = await evalRetrieve(baselineRetrieve(vault), 0, DRIFT_GUARD_N);
  const guardOk = guard.hits === DRIFT_GUARD_HITS && guard.rate === DRIFT_GUARD_RATE;
  console.log(
    `DRIFT-GUARD [first-25 lexical]: ${guard.hits}/${DRIFT_GUARD_N} (${guard.rate.toFixed(2)})  ` +
      `${guardOk ? "✅ harness healthy" : "❌ harness BROKEN"}`,
  );
  if (!guardOk) {
    console.log("❌ ABORT: drift-guard failed.");
    process.exit(1);
  }

  // 2. Lexical baseline on the FULL set.
  const lex = await evalRetrieve(baselineRetrieve(vault));
  console.log(`\nLEXICAL  [full-${evalQueries.length}]: ${lex.hits}/${evalQueries.length} (${lex.rate.toFixed(2)})`);

  // 3. Shipped semantic blend (PR #510) on the FULL set.
  const sem = await evalRetrieve(shippedSemanticRetrieve(vault));
  console.log(`SEMANTIC [full-${evalQueries.length}]: ${sem.hits}/${evalQueries.length} (${sem.rate.toFixed(2)})  (PR #510 shipped path)`);

  // 4. Diff + per-query misses (categorize single-hop vs multi-hop for SAG Phase-B).
  const newQs = evalQueries.slice(DRIFT_GUARD_N); // the 25 added in Phase A
  const semNewMisses = newQs.filter((_, i) => !sem.hitIdx.includes(DRIFT_GUARD_N + i));
  const semAllMisses = evalQueries.filter((_, i) => !sem.hitIdx.includes(i));
  console.log(`\n--- SHIPPED-SEMANTIC MISSES (${semAllMisses.length}) ---`);
  for (const m of semAllMisses) console.log(`  ✗ expect=${m.expect}\n     q="${m.q}"`);
  console.log(`\nof which NEW (Phase-A-added) misses: ${semNewMisses.length}/${newQs.length}`);
  console.log(
    `\nVERDICT: shipped semantic ${sem.rate.toFixed(2)} on ${evalQueries.length}q ` +
      `(was 1.00 on 25q). ${sem.rate >= 0.9 ? "✅ holds" : "⚠️ DROPPED — Phase B (multi-hop) warranted"}.`,
  );
  process.exit(0);
}
