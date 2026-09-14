---
effort: 2026-09-15-kcard-retrieval-lift-2
created: 2026-09-15
last: 2026-09-15
status: open
---

# Wayfinder map: 2026-09-15-kcard-retrieval-lift-2 — close the production-ranker gap 0.31 → 0.70

## Destination

Land the two structural levers the blend-lift arc diagnosed, measured through
the served boundary (`inferQueryTags` → `buildRetrieveOptions` →
`retrieveRecords`) on the card-grounded `golden-v2` fixture set:
production MRR 0.312 → gate 0.70 (hit@3 0.333 → 0.85), or an
evidence-backed amendment with per-question-language splits.

## Context

Planner-led (arc-plan.ts, hard-problem/zai/glm-5.3, 793 s, 33 turns —
receipt `receipts/planner-plan.{md,json}` + its measured counterfactual
`receipts/planner-diagnostic.ts`). The planner re-adjudicated from artifacts
(PB-12) and found the 78 failing questions split into **two disjoint
populations**:

- **P-pool (26/78, 33%)** — pure-CJK questions: `inferQueryTags` → `[]` →
  zero lexical eligibility → union = semTop-12 only → cosine-rank>10 =
  rank 0, structurally unretrievable. Fixed by CJK bigrams (pool entry).
- **P-cap (~52/78)** — target is lexical-#1 with margin (measured: Amari q1
  score 3 #1-of-2; SPINE #1-of-103; Canonical Color #1-of-67) but
  α=0.18 caps its blend at 0.18 + (1−α)·cosNorm_gap → below the topK=10
  cut → also rank 0. Precise bound (D1): a competitor outranks the target
  iff `cosNorm_c − cosNorm_t > α/(1−α) = 0.2195` (semantic.ts:222-224,
  retrieve.ts:1226-1255). Fixed by the absolute overlap term.

The levers **compound**: bigrams turn P-pool questions into lexical-#1
targets that then need the absolute term. Neither alone reaches 0.70.

Planner corrections to the opener brief (§5): Canonical Color PASSES the
tag filter (fails the blend, not the filter); probeB is a ghost
(`scripts/probeB-semantic-seed.mjs` does not exist — the committed eval is
50 queries at `scripts/real-retrieval-eval.json` via `retrieval-eval.mjs
--corpus real`; stale pointer at semantic.test.ts:191 to be repaired);
0.312 is a point quote of the 0.276–0.312 run-to-run band (±0.05 jitter —
receipts carry the band, never single-run deltas); no third dominant lever
(idf, pool widening, embed window all examined, none binding).

## Decisions (planner D1–D10)

- **D3 (load-bearing)**: the absolute term uses the overlap **triple**
  `ov = sharedTags + bodyOv + slugOv`, not hier's stem-only — hier's
  stem-only design exists because ITS lexRankNorm is rank-based; flat
  victims already hold lr=1.0 and need raw evidence. β=0.20 (mirror
  SLUG_BETA).
- **blendScore extended by optional param default 0** — graph-health.ts:48
  and drift-guards stay green unmodified.
- **T3 tokenizer lives in leaf module `card-format.ts`** — host-fns ↔
  retrieve is an import cycle; card-format imports only node:fs + obsidian.
  zh function-char filter mandatory; ASCII-first emission.
- Carried env pins `KCARD_HIER_DEFAULT=0`, `KCARD_USAGE_LOG=0`; the
  unpinned served default is hier-first (retrieve.ts:524-527) — the
  scorecard must say all numbers describe the flat lane (D7).
- Goldens are NEVER rewritten; the `generic-paper` hub card is a substring
  hit for 12/13 graphNotes (production.ts:47) and a lexical competitor —
  record, don't fix the ruler.

## Tickets

- **T1** scaffold + red tests (α-cap red via `_testEmbedder` synthetic
  pool; bigram reds; en-only byte-identical pins) + PRE-fix production-lane
  receipts + `zeroTag` diagnostic column + trace-dump diagnostic run.
- **T2** flat-blend absolute term `β·min(ov,3)/3` wired through
  `trySemanticBlend`; α-band receipts [0.12, 0.18, 0.22, fix-on], one
  variant per embed run; 50-query real-retrieval-eval regression.
- **T3** CJK bigrams shared by `inferQueryTags` + `bodyTokenOverlap` via
  `card-format.ts`; no-regression pins for English-only inputs.
- **T4** final gated measurement + per-language scorecard + threshold
  record.
- **T5** gates / reviewer / merge / close-out (devops CLIs, successor).

## Receipts

- `receipts/planner-plan.md` — the plan verbatim.
- `receipts/plan-receipt.json` — zai/glm-5.3, 793 s, playbook d8915ab81340.
- `receipts/planner-diagnostic.ts` — the planner's measured counterfactual
  (population split, lexical-#1 evidence).

## Status log

- 2026-09-15 — effort opened; branch `kcard-retrieval-lift-2` off origin/main
  81f7aae3; T1 in progress.
