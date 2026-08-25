---
type: task
blocking: 05
status: closed
resolution: implemented 2026-08-25 — gate FAIL (recorded, lane stays opt-in CLI-only); see receipts
---

# 04 — USB4 eval gate: resource-tier vs flat generic-card A/B

## Question
On the USB4 corpus, does the resource tier retrieve better than the cheap baseline (this morning's generic-card path scaled to the same corpus)?

## What to build
The parity-D14/D25-style gate: author ~20 English questions answerable from spec section content (held in the effort, written before running arms); run three arms twice each — (a) resource-tier recursive, (b) flat KNN over resource L2 rows, (c) generic-card lane over the same chapters (the morning path, `zk_ingest --source generic`); record hit@5 + MRR per arm in the ticket receipt. Gate: recursive must beat (b) on both metrics, and beat or clearly justify against (c), before any tool-surface wiring. A loss records the numbers and keeps the lane opt-in CLI-only (no shame, no silent drop).

## Acceptance
- [x] Question set (~20) committed with the effort before any arm runs; authoring blind to results (derived from spec TOC/sections) — `eval/questions.json`, commit f3cd7b13 (21 TOC-derived questions covering all 13 chapters + 2 negatives; targets located by section-heading search, spot-verified on page-045/page-699)
- [x] All three arms run twice; hit@5 + MRR table in the ticket Resolution; reproduced winner noted — four arms (the three required + a generic flat-vector ablation, recall-audit style), both runs identical to the digit
- [x] Gate decision recorded (pass/fail + consequence) in the ticket and mirrored in the map Decisions — FAIL, see below; map D9
- [x] No default/tool surface changed by this ticket regardless of outcome — harness is read-only over a throwaway Surreal ns + temp vault; production `context_db` untouched (verified: scratch ns removed at exit)
- [x] Independent reviewer subagent pass on the harness (question-set fairness, metric code) — or disclosed inline fallback — see Review receipts

## Resolution

**Gate verdict: FAIL — recursive does not beat flat on USB4.** The recursive lane
stays opt-in CLI-only (`--mode recursive`); no default switch, no tool wiring
(ticket 05 inherits this as a constraint).

### Harness

`bun-apps/scripts/resource-eval.mjs` (neutral tier, recall-audit.mjs pattern):
one throwaway Surreal ns, four arms over the SAME 839-page corpus —

- **resource-recursive** — ticket-03 heap lane over `resource` (α=0.5, maxLevel 2)
- **resource-flat** — plain KNN over the same `resource` rows (ticket-01 lane)
- **generic-hier** — the morning baseline scaled to the whole corpus: every page
  through the generic adapter (`zk-ingest --source generic` path, sidecars
  excluded) into a temp vault, retrieved through the card lane's production
  default (hierarchicalRetrieve)
- **generic-flat-vector** — pure KNN over the same generic card rows (ablation)

Setup measured: resource build 844 rows (839 L2 + combined-md L2 + 4 tier rows)
all cache-hits (fingerprint skip lane, 1.6s); generic adapt+write 839 cards
176ms; card index build 839 leaves, 14.9s. Scratch ns + temp vault removed at
exit.

### Results (21 graded questions, k=5, bge-m3 @ LM Studio, 2 runs — identical)

| arm | hit@1 | hit@3 | hit@5 | MRR | ±1-lens hit@5 | ±1-lens MRR |
|---|---|---|---|---|---|---|
| resource-recursive | 6/21 | 10/21 | **10/21** | **0.373** | 13/21 | 0.516 |
| resource-flat | 7/21 | 10/21 | **10/21** | **0.397** | 13/21 | 0.540 |
| generic-hier | 6/21 | 9/21 | 10/21 | 0.361 | 15/21 | 0.504 |
| generic-flat-vector | 4/21 | 10/21 | 10/21 | 0.333 | 14/21 | 0.496 |

Strict gate key (single target page): recursive vs flat — hit@5 TIE (10/21),
MRR LOWER (0.373 < 0.397) → **fails "beat (b) on both metrics"**. vs (c)
generic-hier — hit@5 tie, MRR marginally higher (0.373 vs 0.361) → no clear
win over the cheap baseline either.

**±1-lens (diagnostic, NOT the gate key):** a post-hoc lens that also accepts
the section-heading page's continuation (target±1) — USB4 sections routinely
start at a page bottom with their content on the next page (e.g. §9.1 target
page-539 → top1 page-540; §11.3 729→730). Among the 11 strict misses the
adjacent page sits at top-1 for 3 (recursive/flat; generic-hier 2, its
generic-flat-vector ablation 3 of 7) and inside top-5 for 3/3/5 — the lens
gains come mostly from rank-promotion of near misses, not wholesale adjacent
hits (statistic corrected per reviewer S1; originally mis-written as 8/11).
Under this lens recursive STILL does not beat flat (13/21 tie, MRR
0.516 < 0.540); generic-hier actually leads hit@5 (15/21). The verdict is
lens-invariant.

### Why (measured, consistent with ticket 03)

USB4 is a SINGLE-directory tree (839 children under `pages/`): every L2 hit
shares one parent, so the heap descent degenerates — there is no
directory-selection decision for the seed pass to make, and α propagation only
re-mixes one constant dir score into every child (the exact mechanism behind
ticket 03's measured α-invariance). The recursive lane's advantage over flat
is directory PRUNING, which cannot express itself on a one-dir corpus. The
tier rows do not rescue it: they reorder the top ranks slightly (MRR −0.024).

### Consequences

- Recursive lane: opt-in CLI-only, unchanged (the loss case the ticket
  pre-defined — recorded, not dropped).
- α identification stays deferred (fog): unidentifiable on this corpus by
  construction; the next eval corpus MUST be multi-directory.
- Absolute hit@5 is low across ALL arms (~48%) — corpus-level, not lane-level:
  thin L2 abstracts (copyright-line pollution, ticket-01 known limitation) +
  page-granularity vs section-granularity questions. The ±1-lens delta
  (+3–5 hits) shows a large share of the ceiling is the answer-key
  granularity, not embedding quality.
- Receipts: `output/resource-eval/receipt-2026-08-25T12-28-24-597Z.json`
  (per-query top-K recorded; negatives retrieved spec pages as expected for
  KNN — recorded, no scoring impact). A superseded first receipt exists
  (`receipt-2026-08-25T12-26-23-215Z.json`, 841 generic cards — the
  pre-sidecar-exclusion harness); its metrics are identical on every arm, so
  the outcome was not affected by the fix (reviewer N2, disclosed for a
  self-explanatory record).

## Review receipts

Independent reviewer subagent pass on the harness + question set — **APPROVE,
no blockers**. Folded before merge:

- **S1 (doc fix, applied)** — the ±1-lens paragraph's "8 of 11 strict misses
  have the adjacent page in top-1" was not supported by the receipt (actual:
  adjacent@top1 3/11 recursive+flat, 2/11 generic-hier; in-top5 3/3/5).
  Corrected above and in the map fog; the ±1 metrics themselves verified
  correct and the verdict lens-invariant.
- **N2 (disclosure, applied)** — pre-sidecar-exclusion receipt noted above
  (outcome-identical on every arm).
- Verified by the reviewer: metric code correct end-to-end (1-based ranks,
  MRR denominator, negatives unscored); no match collisions possible
  (zero-padded page ids, sidecar uris never match); scratch-ns isolation and
  cleanup; determinism reproduces across PROCESSES (two receipts, different
  pid/ns, identical digits); all four arms share the same live embedder
  (embedQuery's default IS defaultEmbedder — semantic.ts:177); tier-row
  distractor set symmetric across resource arms; generic ingest faithfully
  mirrors the `zk-ingest --source generic` CLI path (same
  adaptGenericMarkdown + ingestRecords); blind authoring verified by commit
  order (questions f3cd7b13 20:24 +0800 precedes harness 04bb3f6b 20:31,
  receipts 12:26Z/12:28Z); receipt metrics recomputed from perQuery — all
  match, including the recursive-vs-flat MRR delta being exactly 0.5/21 (ONE
  query differs between the arms: q1, tier row `.overview.md` displacing
  page-045 from rank 1 to 2).
