# Plan: kcard-quality-lift — measured 0.692/0.153 → gates 0.90/0.70

Reading done (5/5): adapters.ts, semantic.ts, query-gates.ts, bench map, GMSBench card + graph note pair. One framing assumption is measurably wrong (see §5) and it redirects the MRR lever.

## 1. Execution order

```
T1 diagnose-and-embed-text  →  T2 summary-enrich  →  T3 tag-set-quality  →  T4 gates-or-amendment
```

T1 carries a measurement sub-step that decides T3's shape; T2 is independent of T3; T4 closes either green or with an evidence-backed amendment.

## 2. Tickets

### T1 — Embed-text composition + convergence hygiene (the MRR lever)
- **Goal**: make what the semantic index embeds be the note's *content*, not its *scaffolding*; fix the visible convergence corruption. Three sub-changes, each A/B'd alone (see D1):
  - (a) `semantic.ts:85-88` `cardEmbedText`: strip `## 連結` link-list sections and the trailing record-meta block (`type/confidence/status/first_seen/provenance`) from the body before the 800-char slice; include the frontmatter `summary:` (currently discarded with the frontmatter) ahead of the body.
  - (b) Fix the doubled `## 核心想法` header in graph notes (observed at `generic-paper-gmsbench-gpu.md:16-17` — renderCard/detail interplay re-emits the section header; title-strip removes only the H1). Locate in card-render/ingest upsert.
  - (c) Bench diagnostic (not a gate): dump per-miss top-5 + tag-overlap score for 2c, per-question target rank + top-3 distractors for 2d. This is the T3 evidence.
- **Files**: `s2-agent-ext-knowledge-card/src/semantic.ts`, `src/card-render.ts` (or ingest upsert), `bench-kcards/src/lanes/query-gates.ts` (diagnostic dump), red tests in `bench-kcards` + `ingest-generic.test.ts`.
- **Done-when**: red test — embed text for a fixture graph note contains zero sibling slugs (`generic-paper-*`), zero meta boilerplate, and contains the summary; graph-note body has no duplicated section header; deterministic lanes green; **measured 2d MRR improves ≥ 0.10 over 0.153 per accepted variant, with a receipt per variant**.
- **Risks**: embed-text change affects the whole 2364-note index (regression on non-paper notes unmeasured — bite check only covers paper-note removal); sandbox index rebuild must actually trigger (fingerprint = name+mtime, rewritten notes get new mtimes — verify in the diagnostic run, and delete `.knowledge-semantic/` in the converge step to be safe).

### T2 — Structured deterministic summary (adapter L0 lift)
- **Goal**: replace `firstSentenceSummary` (adapters.ts:586) for the generic family with a deterministic structured abstract: join the `核心想法` bullet texts (markdown stripped), cap ~320 chars, fallback to first sentence. No LLM — offline lanes must stay green.
- **Files**: `s2-agent-ext-knowledge-card/src/extractor.ts` (new function) + `adapters.ts:586`; red test in `ingest-generic.test.ts`: a fixture with 3 核心想法 bullets yields a summary carrying claims from bullets 2–3, not just bullet 1's first sentence.
- **Done-when**: red test green; re-converge sandbox; measured 2c/2d before/after (prediction in D2: ~0 effect on 2d until paired with T1(a)'s summary-in-embed; modest 2c effect if retrieveRecords full-text scores the summary — fog item).
- **Risks**: re-ingest convergence — the explicit-summary precedence (`explicit > on-disk > derived`) means new summaries overwrite old on re-converge by design; summary length changes graph-note mtimes → index rebuild cost only.

### T3 — Tag-set quality for graph notes (the 2c lever; shape decided by T1(c))
- **Goal**: raise the graph note's rank under its own card's tag query. Candidates, pick by T1(c) evidence:
  - (i) trim structural boilerplate (`generic`, `paper`, `zettel`) from generic-family tag sets and order distinctive-first under the `slice(0, 10)` cap (adapters.ts:539-541) — if ranking normalizes by tag-set size or boilerplate dilutes IDF;
  - (ii) retrieve.ts ranking-default tune (hotness/linkWeighting) — only if the diagnostic shows a graph note matching all query tags yet losing on hotness/links. Retrieve-side code is in-scope (constraint forbids editing *cards*, not ranking code), but keep it minimal and evidence-gated.
- **Files**: `adapters.ts:530-541` (and/or `retrieve.ts`); red test in `ingest-generic.test.ts` asserting trimmed/ordered tags on a fixture.
- **Done-when**: red test green; measured 2c recall@5 ≥ 0.90 on the 13 cards, or the diagnostic proves the residual is structural and hands T4 the evidence.
- **Risks**: tag changes alter graph edges (shared-tag 連結) — rerun the convergence idempotence + orphan gates; trimming `generic` may break consumers that filter on it (grep `tag === "generic"` / `"generic"` filters in retrieve + graph-health first).

### T4 — Gate or amend
- **Goal**: run the full embed tier; if ≥ 0.90 / ≥ 0.70, flip the recorded gaps in query-gates.ts to enforcing thresholds and update the bench map's gap section; if a residual gap persists, produce the amendment: per-question-language MRR split, best-variant receipts, and a recorded decision in the effort map — never a silent threshold drop.
- **Files**: `bench-kcards/src/lanes/query-gates.ts` (thresholds), `.planning/<effort>/map.md`.
- **Done-when**: gates enforce the targets in `BENCH_EMBED=1 bun test tests/query-gates.test.ts`, or map.md carries D-amendment with receipts.
- **Risks**: flaky LM Studio nulls (retry ×3 exists); embed tier can never gate plain `bun test`.

## 3. Decisions

- **D1 — The MRR lever is `cardEmbedText`, not the adapter summary.** The framing says "thin summary = thin vector"; false — `semantic.ts:86` strips the frontmatter (where `summary:` lives) before slicing, so the summary is *never embedded*. The vector today = H1 title + tags + first 800 chars of raw body. And the observed GMSBench graph note's body tail embeds **8 sibling paper slugs** (`generic-paper-spine-llm`, `-amari`, …) plus meta boilerplate into a short note — active pollution, and all 13 paper notes share this shape. Predicted effect: (a) strip links+meta alone ≈ +0.10–0.20 MRR; (a)+summary-in-embed ≈ +0.10–0.30 more. **A/B**: one variant per bench run (converge → 2d), receipt each, keep winners — the bench is fast, so measure incrementally, never bundle.
- **D2 — Summary enrichment only moves MRR through D1's embed change**; its independent value is card render quality + any full-text scoring in retrieveRecords (fog). Deterministic bullet-join abstract, no LLM call.
- **D3 — 2c is a ranking problem, not a tag-existence problem.** The graph note already carries a superset of the query tags (GMSBench: query `[gpu, memory-safety, benchmark, hpc]`, note has all 4 + 5 more). Misses mean other cards outrank it — tag-count normalization, IDF dilution from boilerplate tags, or hotness/linkWeighting skew. T1(c) measures which; the fix rides the winner. Predicted winner: (i) boilerplate trim + distinctive-first.
- **D4 — No CJK tag harvest this arc.** The 2c query side is Latin frontmatter tags; the 2d embed side already has CJK body text. Unsegmented CJK n-grams would add noise for zero lane benefit. Rejected-with-reason, revisit only if T4's amendment shows a cross-language ceiling.
- **D5 — A/B discipline**: adapter change, semantic change, ranking change each measured in isolation; receipts per variant; the 13 real vault cards are never edited (sandbox re-converge only).
- **D6 — The doubled `## 核心想法` is a bug, not fog** (graph note lines 16-17); red-test-first fix in T1(b). Small embed effect, real corruption.

## 4. Fog of war (probe at execution)

1. **What retrieveRecords actually scores** (tag overlap formula, hotness, linkWeighting defaults) — I did not read `retrieve.ts` (read budget); T1(c) starts here. Also confirm whether returned paths carry `.md` — the bench match at `query-gates.ts:83` is `graphNote.includes(basename)` where `graphNote` has no `.md`; a `.md`-suffixed return would silently never match.
2. **Golden question language** vs Chinese note bodies — determines whether the cross-language amendment path is even relevant. Peek at one golden in T1.
3. Whether retrieveRecords' full-text lane scores the `summary` field (decides T2's 2c value).
4. Sandbox index freshness after adapter-only changes (mtime-driven fingerprint — confirm rebuild; defensively clear `.knowledge-semantic/` in converge).
5. Whether the 1000-char embed cap starves body text on tag-heavy notes (10-tag prefix can eat ~150 chars).
6. Regression surface of an embed-text change across all 2364 notes (only the 13-note bite check exists today).

## 5. Wrong in the framing (file:line evidence)

1. **"Graph-note vectors are built from the note/summary text — thin summary = thin vector"** — wrong. `semantic.ts:85-88`: `cardEmbedText` strips frontmatter (`raw.replace(/^---\n[\s\S]*?\n---/, "")`) *before* the 800-char slice; `summary:` never reaches the embedder. Consequence: summary enrichment alone cannot move MRR at all until T1(a) lands. This is the single most consequential correction — it reorders the levers.
2. **"9/13 cards found in top-5 via retrieveRecords on their own tags"** — the lane demands the *graph note*, not the card, in top-5 (`query-gates.ts:81-83`, match is against `entry.graphNote`). The origin card itself is a strong same-tag competitor that never satisfies the check. So 2c is ranking-under-competition, slightly mis-framed as "tag recall".
3. **Unreported convergence corruption**: doubled `## 核心想法` at `generic-paper-gmsbench-gpu.md:16-17` and the meta/連結 tail pollution (same file) — the framing attributes the gap solely to thin summaries; the artifact shows body-path bugs and link-slug pollution that T1 fixes.
4. Minor: generic tag harvest is ≥4 chars (`adapters.ts:539`) vs hermes ≥3 — accurate in the framing; noting only that the HERMES_STOP list is shared, so any stopword change for tag widening affects both families.

No operating-learning from the 2026-09-06 list applied here — this is source-tree analysis, not a deployed-artifact divergence; learnings 1–2 (verify the artifact, not the label) did shape the method: I read the shipped graph note bytes, not the adapter's intent.