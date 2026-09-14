Plan delivered and persisted at `output/arc-plan-kcard-retrieval-lift-2/plan.md` (executor: commit it as `.planning/2026-09-10-kcard-retrieval-lift-2/receipts/planner-plan.md`, per prior-arc convention). Summary of the five deliverables — with the measurement that changes the plan:

## The decisive finding (PB-12 applied: I re-adjudicated from artifacts, not prose)

I replicated the **exact** production lexical lane (`inferQueryTags` → eligibility gates → `shared*2 + bodyOv + callout` scoring, `SLUG_STOP`/`BODY_STOP` verbatim) offline over all **2365** real knowledge-graph cards. The 0.312 gap has **two disjoint producer populations**:

| Population | Size (measured) | Mechanism | Which lever fixes it |
|---|---|---|---|
| **P-pool** — pure-CJK questions | **26/78 (33%)**; 軟體供應鏈 6/6 | `inferQueryTags` → `[]` → zero lexical eligibility → union = semTop-12 only → cosine-rank>10 = rank 0, structurally unretrievable | bigrams (pool entry) |
| **P-cap** — mixed questions | ~52/78 | Target is **lexical-#1 with margin** (Amari q1: score 3, #1 of 2 eligible; SPINE: #1 of 103; Canonical Color: #1 of 67) but α=0.18 buries it past the **topK=10 cut → also rank 0** | absolute term (in-pool rank) |

That bimodality (48 rank-0 vs 26 top-3, few between) is exactly what the code predicts — the α-cap doesn't just "bound behind ~12 cards", it pushes lexical-#1 targets *below the 10-cut into rank 0*. The levers **compound**: bigrams turn P-pool questions into lexical-#1 targets that then need the absolute term. Neither alone reaches 0.70.

## 1–2. Execution order & tickets
**T1** scaffold + red tests (α-cap red via `_testEmbedder`; bigram reds; en-only byte-identical pins) + PRE-fix receipts (PB-10) + `zeroTag` diagnostic column (derived, goldens untouched) + trace-dump diagnostic run → **T2** flat-blend absolute term `β·min(ov,3)/3`, `ov = sharedTags+bodyOv+slugOv`, β=0.20, `blendScore` extended by optional param default 0 (graph-health.ts:48 + drift-guards stay green unmodified); α-band receipts [0.12/0.18/0.22/fix-on], one variant per embed run → **T3** CJK bigrams in a **leaf module (`card-format.ts` — host-fns↔retrieve is an import cycle)**, zh function-char filter mandatory, ASCII-first emission → **T4** final gated measurement + per-language scorecard + floor bump → **T5** gates/reviewer/merge/close-out (PB-03/04/05/06). Full goal/files/done-when/risks in the plan file.

## 3. Decisions (D1–D10, file:line in plan)
Load-bearing: **D1** precise bound `cosNorm_c − cosNorm_t > 0.2195` (semantic.ts:222-224, retrieve.ts:1226-1255); **D2** levers compound, receipts isolate one variable; **D3** absolute term uses the overlap *triple*, not stem-only (hier's stem-only design exists because *its* lexRankNorm is rank-based — flat victims already hold lr=1.0); **D7** carried env pins + scorecard caveat: the *unpinned* served default is hier-first (retrieve.ts:524-527) — 0.312 and every receipt describe the flat lane; **D9** ±0.05 jitter band, never single-run deltas.

## 4. Fog of war
Pre-fix `includeTrace` dump ({lr, cosNorm, rank} × 78); cross-paper semantic crosstalk (13 same-format zh cards embed near each other); the `generic-paper` hub card is a substring-**hit** for 12/13 papers' graphNotes (production.ts:47) and a lexical competitor — record, don't rewrite goldens; real-vault cache-rebuild dirty-gitlink noise; Surreal-up for the optional hier sub-lane; 2c lane drift post-T3.

## 5. What's WRONG in the brief (evidence)
1. **"Canonical Color fails the tag filter" — false**: simulated #1 of 67, both query tags on the card's frontmatter. It fails the blend, not the filter.
2. **"cosNorm>0.22 outranks"** holds only when the target is union-min cosine; general bound is the 0.2195 *gap*, and the damage is often rank-0 (below the cut), not rank 9-12.
3. **probeB is a ghost**: `scripts/probeB-semantic-seed.mjs` doesn't exist (semantic.test.ts:191 stale pointer); the committed eval is **50** queries at repo-root `scripts/real-retrieval-eval.json` via `retrieval-eval.mjs --corpus real`. The plan repairs the pointer.
4. **0.312 is a point quote of a 0.276–0.312 band** — thresholds compare against receipts with the jitter band.
5. **No third dominant lever**: idf weighting (target already wins lexical-#1), pool widening (amendment-time only), embed window (already lifted) — all examined, none binding for this fixture set.

**PB citations applied**: PB-12 (re-adjudicate from artifacts; suspect the ruler — checked the substring hit-matcher too), PB-10 (PRE-fix receipts baked into T1), PB-11/PB-14 (pre-registered α-band, one variant per run), PB-13/PB-15 (receipts preserved, gaps recorded), PB-18 (evidence under `.planning/<effort>/evidence/`), PB-21 (content-pinned tokenizer tests), PB-02/03/04/05/06 (close-out discipline encoded in T5). Deploy-tree learnings (1/2/8/9) don't apply — nothing here ships through the bundler; the method rule (read the artifact, not the label) is what produced §5.