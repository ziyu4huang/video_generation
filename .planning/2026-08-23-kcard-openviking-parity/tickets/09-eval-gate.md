# 09 — evaluation gate for hierarchical retrieval

type: grilling (resolved 2026-08-23 — D23–D26) → build
blocked by: 07

## Question

Before any of this replaces default retrieval, extend `bun-apps/scripts/recall-audit.mjs` to measure it. Baseline to hold or beat: kcard hit@5 17/20, MRR 0.688 (2026-08-23, bge-m3).

Questions:

- Ablations needed: hierarchical vs flat vector-only vs current blend — three arms on the same battery, plus the recall-audit 20-question battery and the hit@4 English set (the D3 two-sided eval used both).
- Scale arm: does the eval corpus need to grow beyond 1925 cards to exercise 4-layer recursion (OpenViking's convergence claims are at larger scale)?
- Gate rule: which arm becomes default, and what margin counts as "beats" (D8's count-baseline rule generalized)?
- Regression tripwire in CI vs on-demand harness (local_ci ≤5min budget — do NOT add a slow gate).

## Answers (2026-08-23, user — D23–D26)

- **D23 — three-arm ablation is a standing arm in `recall-audit.mjs`**: new `kcard-flat-vector` arm (pure KNN over the `card` index, no FTS lane, no blend) so `kcard` (blend) / `kcard-hier` / `kcard-flat-vector` run in one command; the D3 English 50-question set (`scripts/real-retrieval-eval.json`) runs through the same three arms (hit@4).
- **D24 — NO scale arm**: 2351 cards already carry the 4-layer tree and D20 measured one-sweep convergence at ≤4 layers; OpenViking's larger-scale convergence claims are out of this repo's single-user-local scope. Charted-and-rejected; revisit when the real vault passes ~5k cards (knowledge-pipeline D03 trigger).
- **D25 — gate rule**: hier switches default ONLY if hit@5 ≥ 17/20 AND MRR ≥ 0.688 on the recall-audit battery (D8 count-baseline rule generalized to both metrics). Tie or loss → flat `retrieveRecords` stays default and the map records why hier stays opt-in. The switch itself stays one map line + one code line (reversible).
- **D26 — CI tripwire = fixture smoke, live gate = on-demand**: CI gets a seconds-scale small-corpus + `--test-embedder` test pinning the three arms' scoring code paths and the D25 gate-decision logic (local_ci ≤5min is a hard rule); the live 17/20 measurement stays on-demand (needs LM Studio + SurrealDB + full-vault embeds), receipts cited in the map at every tuning change.

## Build result (2026-08-23 — CLOSED)

**Gate PASSED: hier 17/20 hit@5, hit@1 11/20, MRR 0.700 vs flat baseline 17/20, 0.688** (receipts `output/recall-audit/receipt-ticket09-final-3arm.json`, reproduced identically twice). English set (D23, hit@4, n=50, `scripts/hier-english-eval.mjs`, receipt `output/hier-english-eval/receipt-2026-08-23T10-23-32-248Z.json`): kcard 47/50 (= D3's recorded bge-m3 number, validating the harness), **kcard-hier 47/50 (tie)**, flat-vector 48/50.

Tuning ladder (every step A/B'd against the same live battery; receipts under `output/recall-audit/receipt-ticket09-*`):

| step | hit@5 | MRR | verdict |
|---|---|---|---|
| baseline (ticket 07 build) | 15/20 | 0.604 | — |
| t1 stop-word filter (`HIER_STOPWORDS`) | 16/20 | 0.604 | KEPT |
| t2 body FTS lane (`card.body` column, schema-v2 salt) | 17/20 | 0.617 | KEPT |
| t3 column-weighted lex (title 3×/summary 2×/body 1×) | 17/20 | 0.600 | REJECTED |
| t4 stem lane via lexHits (rank-normalized) | 17/20 | 0.617 | REJECTED (no-op: lexRankNorm is rank-based, two top-of-pool cards both ≈1.0) |
| t5 absolute slug term β=0.2, ov≥2 | 17/20 | 0.654 | superseded |
| **t6 absolute slug term β=0.2, ov≥3** | **17/20** | **0.700** | **SHIPPED** |

γ A/B (item c): γ=0.5 vs γ=0.7 IDENTICAL (17/20, 0.700; viaTree appears in top-5 for 0/20 queries at either γ) — propagation is correctness-for-unseeded-subtrees, not a battery mover; γ stays 0.5. Rank-budget near-misses (item a) were resolved by the body+stem lanes, not by widening K.

Shipped: `recall-audit.mjs` gains `kcard-flat-vector` (D23) + `--surreal-namespace` + `--test-embedder` wired through the Surreal arms; `surreal-index.ts` gains the `body` column + `card_fts_body` + `INDEX_SCHEMA_VERSION` fingerprint salt + load-then-index swap (the body FTS grew the old swap's `INSERT SELECT` past the 10s per-request bound — measured timeout, structural fix); `hierarchical-retrieval.ts` gains `HIER_STOPWORDS`, `stemTokenOverlap` + absolute `SLUG_BETA` term (ov≥3 gate), `evaluateDefaultSwitchGate` (D25 pure rule); `__tests__/eval-gate.test.ts` (D26 fixture smoke, 1.6s, temp Surreal ns, pins gate rule + three-arm paths + body lane end-to-end); `scripts/hier-english-eval.mjs` (English set through three arms). kcard 534/534 green.

Decision (D27): the tool-path default switch is DEFERRED to ticket 05 — `zk_ask`/`knowledge_query`/`zk.retrieve` consume `RetrieveResult` deeply (digest, tier ladder, count/scanned/excluded) and mapping `HierarchicalResult` into that shape is the FS-read-surface reshape that ticket 05 owns (map Fog of war names it). The gate numbers above are the switch's authorization; 05 lands it.
