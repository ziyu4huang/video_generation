---
effort: 2026-09-15-kcard-retrieval-lift-2
created: 2026-09-15
last: 2026-09-15
status: executing
---

# Wayfinder map: 2026-09-15-kcard-retrieval-lift-2 — close the production-ranker gap

## Destination

Land the structural levers diagnosed for the production-ranker MRR gap,
measured through the served boundary (`inferQueryTags` →
`buildRetrieveOptions` → `retrieveRecords`) on card-grounded `golden-v2`
(78 answerable questions, never rewritten), or record an evidence-backed
amendment.

## Decisive executor finding — the ruler was broken (T0, before any lever)

The planner's 793 s opener (hard-problem/zai/glm-5.3, receipt
`receipts/planner-plan.{md,json}` + measured counterfactual
`receipts/planner-diagnostic.ts`) split the 78 failures into P-pool
(pure-zh, zero tags) + P-cap (α-cap below the topK cut) and prescribed
bigrams + an absolute blend term. Re-adjudicating from artifacts (PB-12)
found the measurement itself corrupted first:

**`buildNoteMap` (bench-kcards) bound golden papers to graph notes by FIRST
CONTENT SUBSTRING HIT on the title — and graph notes cross-link sibling
paper titles in their 連結 sections.** Measured on disk: 6-7/13 papers
mis-bound (GMSBench→privescalate note, ReCite & SPINE→procedural-graphs,
Image Tokenizers→canonical-color, Transformers→amari, 軟體供應鏈→gmsbench).
Every lane consuming the map — tag recall AND the recorded 0.312 production
MRR — measured retrieval against WRONG targets. The 0.692 tag-recall gap
and much of the MRR gap were ruler artifacts.

Fix (commit 80f7bdf6, red tests first): bind via the graph note's
FRONTMATTER `source:`/`sources:` == `generic:<origin-card-stem>` (exact,
order-independent; verified present on all 13 notes). Also fixed the
sandbox to converge with per-record labels (the uniform
`generic:paper-cards` label rewrote every note's `source:`, starving the
binding in-converge — commit with 8f-prefix series, see `converge-sandbox.ts`).

Corrected canonical numbers (embed tier, sandbox, golden-v2, flat lane,
KCARD_HIER_DEFAULT=0/KCARD_USAGE_LOG=0):

| surface | tag recall@5 | MRR | hit@3 |
|---|---|---|---|
| recorded pre-arc (broken ruler) | 0.692 | 0.312 | 0.333 |
| T0-corrected baseline | **1.000** (design target 0.90 MET — gate flipped to enforcing) | 0.360 | 0.370 |
| post T2+T3 (f31ce6d8) | 1.000 | **0.720** | 0.769 |

## Levers landed (planner T2/T3, red-test-first)

- **T2 — absolute blend term** (semantic.ts + retrieve.ts): `blendScore`
  gains optional `β·min(ov,3)/3`, β=`SEMANTIC_LEX_BETA_DEFAULT`=0.2, ov =
  the evidence triple sharedTags+bodyOv+slugOv threaded as `_lexOv` from
  the lexical scan; semantic-only union cards honestly carry ov=0. Cures
  the D1 cap (cosNorm gap > 0.2195 outranks a lexical-#1 target → below
  the topK cut). β default 0 at the pure level — all existing call sites
  byte-identical. **Usage multipliers (Surreal hotness + used-ledger)
  scale the α-blend BASE only, β re-added unscaled** — the D8 boundary
  (m(h) < 12/11) lives on multiplicative ratios an additive constant
  would compress; both hotness integration tests updated to the scoped
  contract, multiplier-once (reviewer F1) still pinned.
- **T3 — CJK bigrams** (card-format leaf — host-fns↔retrieve is an import
  cycle): `cjkBigrams`/`lexicalTokens`; `inferQueryTags` appends deduped
  bigrams after the ASCII pass (cap 24; English-only byte-identical);
  `bodyTokenOverlap` adds bigrams to the body token set and exempts CJK
  tags from the ≥3-char gate. Pure-zh queries previously got ZERO tags →
  no lexical lane at all.

Red tests: `lexical-blend.test.ts` (pool-cut rescue integration with
`_testEmbedder`, blend flip pair, zh bodyMatch, English pins) +
`note-map.test.ts` (absent-target steal, cross-link order,
body-provenance). Suites: knowledge-card 818/818, bench 16/16, typecheck
clean.

## Planner corrections recorded (planner-error log)

- §5.3 "probeB is a ghost" — FALSE: `scripts/probeB-semantic-seed.mjs`
  exists; its semantic leg is machine-blocked this session (nomic model
  listed but unloaded in LM Studio — "Model unloaded..", 2 attempts);
  its lexical drift-guard (0.84) and the 50-query
  `real-retrieval-eval.json` remain available; regression evidence for
  the ranker change = the 818-test suite + the bench embed tier.
- The planner's population split (P-pool/P-cap sizes) came from its own
  diagnostic, which (a) replicated the broken title-substring target
  binding and (b) gated lexical eligibility BEFORE computing bodyOv —
  the real lane includes body-token-only cards. Its numbers were
  directionally right (levers compound) but quantitatively void; the
  canonical bench receipts above supersede them.

## Residual classes (post-fix, 9 rank-0 / 78)

5 are graph-RELATION questions ("這張卡與哪兩張卡片有相關連結？") whose
queries carry no topical anchor — answerable from the card (goldens are
card-grounded) but not discriminatively retrievable by any content
ranker; they are zk_ask-shaped (LLM reads the card), not ranker-shaped.
Rest: page-anchor lookups ("Figure 1 位於第幾頁") and relation-adjacent
paraphrases at rank 4–10. Recorded as the amendment material for any
future 0.85+ target — hit@3 0.769 vs gate 0.85 is short for this class.

## Tickets

- **T0** ruler fix — DONE (80f7bdf6 + converge label fix).
- **T1** re-measure — DONE (corrected baseline table above).
- **T2/T3** levers — DONE (f31ce6d8).
- **T4** α-band + repeat receipts — IN PROGRESS (post-fix receipt
  `receipts/production-mrr-post-fix.json`; repeat + α∈{0.12,0.22} running).
- **T5** gates / reviewer / merge / close-out.

## Receipts

- `receipts/planner-plan.md`, `receipts/plan-receipt.json`,
  `receipts/planner-diagnostic.ts` — planner (zai/glm-5.3, 793 s,
  playbook d8915ab81340).
- `receipts/production-mrr-post-fix.json` (+ band runs landing) —
  canonical production-lane measurements with per-question detail.

## Status log

- 2026-09-15 — effort opened; branch `kcard-retrieval-lift-2` off
  origin/main 81f7aae3.
- 2026-09-15 — T0 ruler fix landed; corrected baseline measured; T2+T3
  landed; post-fix MRR 0.720 recorded.
