---
effort: 2026-09-15-kcard-hit3-residual
created: 2026-09-15
last: 2026-09-15
status: executing
---

# Wayfinder map: 2026-09-15-kcard-hit3-residual — hit@3 0.744 → 0.85, pre-adjudicated

Builds-on: 2026-09-15-kcard-retrieval-lift-2

## Destination

Close the hit@3 residual on the production ranker (hit@3 0.744 → gate
0.85, MRR holding ≥ 0.70) on card-grounded golden-v2 through the served
boundary — or land the PRE-registered per-class amendment with the
unservable class receipted (planner D2/D3).

## Context

Planner-led (arc-plan.ts, hard-problem/zai/glm-5.3, 757 s — receipt
`receipts/planner-plan.{md,json}`, live probe
`evidence/planner-rel-probe.mjs`). Pre-adjudication from the final-tree
receipt (28 non-rank-1, 11 rank-0 — the successor's "34/9" was wrong):

| class (derived) | n | hit@3 | MRR |
|---|---|---|---|
| relation-anchored | 8 | 0.125 | 0.151 |
| relation-bare | 4 | 0.000 | 0.000 |
| page | 5 | 0.600 | 0.558 |
| topical | 61 | 0.885 | 0.844 |
| total | 78 | 0.744 | 0.711 |

- **relation-bare (4) is unservable by ANY question-only ranker** — 3 are
  byte-identical queries targeting 3 different cards; probe: 0
  distinctive tokens each. Recorded gap, never a pass (D2).
- **relation-anchored (8) has an offline-proven signal**: anchor phrases
  exist verbatim in target cards' `## 連結` sections; 連結-scoped
  distinctive-overlap ranks 6/8 targets #1.
- Relation lever ceiling alone: 58+7 = 65/78 = 0.833 < 0.85 → amendment
  pre-registered (D3), triggered iff no receipted config crosses 0.85
  with MRR ≥ 0.70.
- Planner corrections: `parseRelationsBlock` parses frontmatter
  `relations:` — zero cards have it; the signal surface is the markdown
  `## 連結` section (1867/2364 cards), which `cardEmbedText` STRIPS
  (semantic.ts ~:108) — embed-invisible, lexically visible but drowned.
- The 0.85/0.70 gates exist only as comments today — this arc must
  enforce them as scorecard rows or amend them explicitly.

## Tickets

- **T1** `classifyQuestion` (classify.ts; 4 classes, question-text only,
  census-pinned {8,4,5,61}) + `perClass` column in productionMrr +
  receipt-run out-dir parameterization + PRE-fix per-class evidence
  (offline, from the existing final-tree receipt).
- **T2** relation lever V1: gated 連結-scoped lexical term
  `REL_TERM·min(relOv,3)/3` when the query is relation-intent; relOv
  counts into `_lexOv`. Red-first; ONE embed receipt; PRE-registered
  acceptance: REL-anchored hit@3 ≥ 0.75, overall MRR ≥ 0.711, topical
  hit@3 EXACTLY unchanged, overall hit@3 ≥ 0.80. V1 never re-rolled; at
  most one V2 in T3.
- **T3** α-band decision, conditional (only if T2 < 0.85): receipts
  α∈{0.26, 0.30} on the LEVER tree; flip SEMANTIC_ALPHA_DEFAULT only if
  hit@3 ≥ 0.85 AND MRR ≥ 0.70; optional V2 (連結 into cardEmbedText +
  embed-cache fingerprint text-version constant) if F1 shows α-cap.
- **T4** gate enforce-or-amend as scorecard data rows; amended floors:
  MRR ≥ 0.70 overall; REL-anchored ≥ 0.75; PAGE ≥ 0.60; topical ≥ 0.885
  no-regression; REL-bare = recorded gap with probe evidence.
- **T5** reviewer → PR → merge → map Shipped-as → successor + LATEST.

## Verdict (measured, all receipted)

- **Served blended lane (α=0.18, lever in): MRR 0.711 / hit@3 0.744** —
  deterministic across sessions (repeat + repeat-2). MRR gate MET;
  hit@3 gate NOT met on the served lane.
- **Pure-lexical ablation (semantic:false, offline deterministic):
  0.868 / 0.885** — crosses both gates; the accidental lever-v1 embed
  receipt matched it to the third decimal, exposing that run as an
  LM-Studio-unavailable fall-through, not the served lane.
- **α-band (lever tree): 0.26→0.821, 0.30→0.833** (MRR 0.753/0.761) —
  monotone, still short of 0.85 → per pre-registered D4 the served
  default HOLDS at 0.18; the α flip is queued as successor head
  (requires the semantic-gap regression eval — probeB/nomic — before
  flipping).
- **V2 (bounded 連結 embed tail) RECEIPT-REJECTED**: MRR 0.689 < 0.70,
  topical 0.885→0.852 — text reverted to the v1 composition; the
  textVersion cache mechanism is KEPT (backward-compatible) so the next
  composition change cannot serve stale vectors.
- **Amendment (pre-registered D3) LANDED**: enforce floors as data rows
  (MRR ≥ 0.70; hit@3 ≥ 0.74; anchored ≥ 0.12; page ≥ 0.60; topical
  ≥ 0.88) asserted in the embed-tier test; design target hit@3 ≥ 0.85
  stays REPORTED-unmet with the receipts; relation-bare = recorded gap
  (unservable by construction, probe evidence).
- relation-bare stayed 0.000 on every lane and every variant ✓
  (mechanically honest).

## Receipts

- `receipts/planner-plan.md`, `receipts/plan-receipt.json`,
  `evidence/planner-rel-probe.mjs` — planner (zai/glm-5.3, 757 s,
  playbook d8915ab81340).
- `evidence/pre-fix-per-class.json` — per-class baseline (offline).
- `evidence/inert-{with,no-lever-TRUE}.txt` — REAL gate-inertness proof
  (66/66 byte-identical vs the true 653bb284 retrieve.ts; the earlier
  stash-based proof was void — the lever was already committed).
- `receipts/production-mrr-{lever-v1,lever-v1-repeat,lever-v1-repeat-2,
  band-a26,band-a30,v2-a18,lexical-lane-ablation}.json` — the full
  measurement story including the accidental ablation and its offline
  reproduction.

## Status log

- 2026-09-15 — effort opened; branch `kcard-hit3-residual` off
  origin/main 653bb284; T1 in progress.
