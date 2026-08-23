# 09 — evaluation gate for hierarchical retrieval

type: grilling
blocked by: 07

## Question

Before any of this replaces default retrieval, extend `bun-apps/scripts/recall-audit.mjs` to measure it. Baseline to hold or beat: kcard hit@5 17/20, MRR 0.688 (2026-08-23, bge-m3).

Questions:

- Ablations needed: hierarchical vs flat vector-only vs current blend — three arms on the same battery, plus the recall-audit 20-question battery and the hit@4 English set (the D3 two-sided eval used both).
- Scale arm: does the eval corpus need to grow beyond 1925 cards to exercise 4-layer recursion (OpenViking's convergence claims are at larger scale)?
- Gate rule: which arm becomes default, and what margin counts as "beats" (D8's count-baseline rule generalized)?
- Regression tripwire in CI vs on-demand harness (local_ci ≤5min budget — do NOT add a slow gate).
