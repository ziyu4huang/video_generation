/**
 * bench/dedup-baseline.ts — runs the CURRENT dedup detection layers against the
 * golden corpus (dedup-golden-corpus.ts) and emits per-layer P/R/F1 plus a
 * near-dup threshold sweep (0.3-0.9 vs the current 0.60 default).
 * Wayfinder ticket 07. Methodology locked in ticket 02 (detection-quality only).
 *
 * Eval protocol (per layer): positive = pairs labeled for that layer's category;
 * negative = non-dup pairs; pairs of OTHER positive labels are excluded from the
 * P/R/F1 math but their cross-firing is reported as a diagnostic. exact-dup
 * detection uses a local normalizer mirroring MemoryStore.dedupNormalize
 * (trim + collapse whitespace); near-dup and topic use the REAL exported
 * detection functions, tested both directions.
 */
import { GOLDEN_PAIRS, type DedupLabel } from "./dedup-golden-corpus.ts";
import { findNearDuplicate, DEFAULT_NEAR_DUP_THRESHOLD } from "../src/store/near-dup.ts";
import { findTopicRecurrence } from "../src/store/topic-key.ts";

function localNormalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

const exactHit = (a: string, b: string) => localNormalize(a) === localNormalize(b);
const nearHit = (a: string, b: string, t: number) =>
  findNearDuplicate(b, [a], t) !== null || findNearDuplicate(a, [b], t) !== null;
const topicHit = (a: string, b: string) =>
  findTopicRecurrence(b, [a]) !== null || findTopicRecurrence(a, [b]) !== null;

type LayerId = "exact" | "near-dup" | "topic";
const labelToLayer: Record<DedupLabel, LayerId | null> = {
  "exact-dup": "exact",
  "near-dup": "near-dup",
  "topic-recurrence": "topic",
  "non-dup": null,
};

interface LayerResult {
  layer: LayerId; threshold?: number; pos: number; neg: number;
  tp: number; fp: number; fn: number; tn: number; crossFire: number;
  p: number; r: number; f1: number;
}

function evalLayer(layer: LayerId, detects: (a: string, b: string) => boolean, threshold?: number): LayerResult {
  let pos = 0, neg = 0, tp = 0, fp = 0, fn = 0, tn = 0, crossFire = 0;
  for (const pair of GOLDEN_PAIRS) {
    const l = labelToLayer[pair.label];
    const det = detects(pair.a, pair.b);
    if (l === layer) { pos++; det ? tp++ : fn++; }
    else if (l === null) { neg++; det ? fp++ : tn++; }
    else if (det) crossFire++;
  }
  const p = tp + fp === 0 ? 0 : tp / (tp + fp);
  const r = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  return { layer, threshold, pos, neg, tp, fp, fn, tn, crossFire, p, r, f1 };
}

const exact = evalLayer("exact", exactHit);
const topic = evalLayer("topic", topicHit);
const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const sweep = thresholds.map((t) => evalLayer("near-dup", (a, b) => nearHit(a, b, t), t));
const nearDefault = sweep.find((s) => s.threshold === DEFAULT_NEAR_DUP_THRESHOLD)!;
const best = sweep.reduce((a, b) => (b.f1 > a.f1 ? b : a), sweep[0]);

const byLabel = GOLDEN_PAIRS.reduce((m, p) => ((m[p.label] = (m[p.label] || 0) + 1), m), {} as Record<DedupLabel, number>);
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const f3 = (x: number) => x.toFixed(3);

const L: string[] = [];
L.push("# Dedup Quality Baseline — wayfinder ticket 07");
L.push("");
L.push(`Corpus: **${GOLDEN_PAIRS.length} pairs** — exact-dup ${byLabel["exact-dup"]}, near-dup ${byLabel["near-dup"]}, topic-recurrence ${byLabel["topic-recurrence"]}, non-dup ${byLabel["non-dup"]}.`);
L.push("");
L.push("> Detection-quality only (conflict/merge-plan out of scope, per ticket 02). Seeds are realistic memory-style content, not verbatim MEMORY.md lifts — real-seed fidelity is a flagged follow-up. exact layer uses a local normalizer mirror; near-dup & topic use the REAL exported detection functions (both directions).");
L.push("");
L.push("## Per-layer P/R/F1");
L.push("");
L.push("| layer | threshold | P | R | F1 | TP | FP | FN | TN | pos | neg | crossFire |");
L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
const rowm = (r: LayerResult) => `| ${r.layer} | ${r.threshold ?? "—"} | ${f3(r.p)} | ${f3(r.r)} | ${f3(r.f1)} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${r.pos} | ${r.neg} | ${r.crossFire} |`;
L.push(rowm(exact));
L.push(rowm(nearDefault));
L.push(rowm(topic));
L.push("");
L.push("`crossFire` = times the layer fired on pairs labeled for a DIFFERENT layer (excluded from P/R/F1; diagnostic only).");
L.push("");
L.push("## Near-dup threshold sweep (0.3–0.9)");
L.push("");
L.push("| threshold | P | R | F1 | TP | FP | FN |");
L.push("|---|---|---|---|---|---|---|");
for (const s of sweep) L.push(`| ${s.threshold} | ${f3(s.p)} | ${f3(s.r)} | ${f3(s.f1)} | ${s.tp} | ${s.fp} | ${s.fn} |`);
L.push("");
L.push(`- **Current default (${DEFAULT_NEAR_DUP_THRESHOLD}):** P=${f3(nearDefault.p)} R=${f3(nearDefault.r)} F1=${f3(nearDefault.f1)}`);
L.push(`- **F1-optimal threshold:** ${best.threshold} (F1=${f3(best.f1)}, P=${f3(best.p)}, R=${f3(best.r)})`);
L.push("");
L.push("## Findings");
L.push("");
L.push(`- **exact layer:** recall ${pct(exact.r)} on ${exact.pos} normalize-equal pairs (corpus invariant — exact pairs are normalize-equal by construction; measures the invariant, not layer capability).`);
L.push(`- **near-dup @${DEFAULT_NEAR_DUP_THRESHOLD}:** catches ${nearDefault.tp}/${nearDefault.pos} semantic near-dups (R=${pct(nearDefault.r)}); F1=${f3(nearDefault.f1)}.`);
L.push(`- **near-dup best F1:** threshold ${best.threshold} → F1=${f3(best.f1)} (Δ vs current ${f3(best.f1 - nearDefault.f1)}).`);
L.push(`- **topic-recurrence:** catches ${topic.tp}/${topic.pos} recurrence pairs (R=${pct(topic.r)}); crossFire=${topic.crossFire}.`);
L.push("- Low-containment synonym-rewrite near-dups (containment < 0.6) are the expected recall gap for token-containment — quantified in the sweep's FN column.");
L.push("");
L.push("_Generated by bench/dedup-baseline.ts — deterministic; re-run anytime._");
const md = L.join("\n");

const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 8) + "-" + new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const outPath = `bench/results/dedup-baseline-${ts}.md`;
await Bun.write(outPath, md);
console.log("WROTE " + outPath);
console.log("");
console.log(md);
