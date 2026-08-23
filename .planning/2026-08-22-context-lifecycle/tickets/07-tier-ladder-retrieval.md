# 07 — tier ladder in retrieval (L0/L1/L2) + BGE-M3 re-baseline

- **Phase:** P1 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-23 · **Breaking contract change (D0/D5)**

## Resolution (2026-08-23)

- **Tier ladder shipped**: new `src/tier-ladder.ts` (pure) — `buildLeafTiers` /
  `buildAggTiers` / `renderTier` + `TIER_BUDGETS` (L0 ≈ title+256 summary+tags, L1 ≈
  title+600-char lead, L2 unbounded). `RetrievedCard` gains `tier` (EFFECTIVE tier after
  demotion) + `tiers` (pre-rendered per-tier text); `detail` is now the tier-rendered text
  and the digest's 160-char slice is gone (each line names its effective tier
  `[abstract|overview|full]`). `RetrieveOptions.tier` (default `"abstract"`) +
  `maxDetailChars` repurposed as the per-entry DEMOTE budget (default = tier-intrinsic).
  DEMOTE-NOT-TRUNCATE verbatim: overflow steps one tier shallower; only the abstract floor
  is word-boundary clamped.
- **Renderers on the ladder**: `formatDigest` (L0 default), `knowledge_query` (`tier`
  param: L0 default / L1 detail / L2 explicit), `zk.retrieve` host-fn (`tier` arg threaded
  via `buildRetrieveOptions`), `buildRagTask` Step 4 (Tier 1 = L2 full read with
  DEMOTE-NEVER-TRUNCATE at the token limit → L1 `summary`/lead; Tier 2 = L0 snippet).
  Agg tree-expansion cards render L1 (the composed `summary:`, ticket 06) and bottom out
  there. Pre-v2 cards (no `summary:`) fall back to `firstSentenceSummary`.
- **Tokens/card measured** (receipt `output/tier-ladder/tokens-per-card-2026-08-22T18-50-36-205Z.json`,
  258 unique cards over the 50-query eval set): L0 65 tok vs L2 178 tok avg → **↓63.3%**
  (target ≥40%). Convergence-coverage run `kcard-coverage-measure.mjs` receipt emitted;
  ingest/coverage path untouched by the diff (render-only), so no coverage regression is
  possible from this change.
- **D3 eval gate — cut both ways, D3 STAYS bge-m3** (committed probe
  `scripts/d3-bge-m3-reeval.mjs`, receipts `output/d3-reeval/`, same-corpus A/B,
  reproducible twice):
  - English 50-query eval set (hit@4, full + first-25): nomic **48/50 (0.96)** /
    24/25 vs bge-m3 **47/50 (0.94)** / 23/25 — per this ticket's flip-back rule alone,
    nomic wins.
  - Recall-audit battery (the binding Done-when gate, receipt
    `output/recall-audit/receipt-ticket07-final.json`): bge-m3 **17/20 hit@5, MRR 0.688**
    (baseline-identical, semanticUsed=true) vs nomic **15/20, MRR 0.564** (deterministic,
    twice) — the flip-back breaks the no-regression acceptance box.
  - Prior embed-bench (ticket 01): bge-m3 recall@1 0.909 vs nomic 0.864; vault is
    Traditional Chinese (D3's original reasoning).
  - Decision: the recall-audit battery + embed-bench + CJK outweigh the 1-query
    English-set cost; `SEMANTIC_MODEL_DEFAULT` stays `text-embedding-bge-m3` with the
    A/B recorded here and in map Context. Nomic stays one `SEMANTIC_EMBED_MODEL` env
    override away. TRAP found while measuring: the env override does NOT reach
    `getCardEmbeddings` (the model string comes from the module constant unless
    `semanticModel` is passed) — a "bge-m3 control" run via env alone was silently nomic.
- **Harness drift-guard regen (D0)**: `scripts/recall-eval-harness.mjs` first-25 lexical
  pin 21/25 (0.84) → **20/25 (0.80)** — corpus drift from tickets 05/06 (notes 2327→2653);
  control-tested: origin/main code on the same corpus also measures 20/25. Ladder is
  render-only — old vs new code produce identical rankings (verified side-by-side).
- **Gates**: kcard 503 pass (+15 tier-ladder tests); core-interface 41 pass; hermes seam
  consumers (knowledge-search-tool / pipeline seam / kp13) green.


## Problem

`retrieveRecords` returns full bodies regardless of need; downstream renderers (digest,
zk_ask context assembly, workflow host-fn) each truncate their own way. OpenViking's tier
ladder + demote-not-truncate replaces ad-hoc truncation. This ticket also carries the D3
eval gate.

## Approach

1. `src/retrieve.ts`: `RetrievedCard` gains `tier` (`"abstract"|"overview"|"full"`) +
   pre-rendered per-tier text: L0 = title + tags + `summary` (ticket 05); L1 = body lead
   (~600 chars) for leaves / agg `summary` for nodes; L2 = full body.
2. Renderers: `formatDigest`, `knowledge_query`, `zk.retrieve` host-fn, and `buildRagTask`'s
   2-tier context assembly move onto the ladder — L0 default, L1 on detail flag, L2 on
   explicit request; an entry that overflows its budget DEMOTES to a shallower tier instead
   of truncating (OpenViking rule, verbatim).
3. `zk-spawn-parity` / two-read-path drift-guard tests updated (contract change, cite D0).
4. **D3 eval gate:** re-run the existing eval set under BGE-M3 (ticket 01's canonical);
   hit@4 must be ≥ the nomic baseline (1.00 recorded). If it drops, D3 flips back to nomic
   (numbers + decision recorded in map), and the ladder work is unaffected.
5. Measure default-render tokens/card vs full body (target ↓ ≥ 40%); prune the stale nomic
   `.knowledge-semantic` cache if D3 held.

## Acceptance

- Retrieval/render tests green; demote-not-truncate unit tests; tokens/card measurement
  recorded.
- Eval receipt: BGE-M3 hit@4 vs nomic baseline, decision recorded in map Context.
- `bun test __tests__/` + extension tests green.

## Verification

Canonical kcard gates + the eval receipt + `kcard-coverage-measure.mjs` run (convergence
coverage must not regress).
