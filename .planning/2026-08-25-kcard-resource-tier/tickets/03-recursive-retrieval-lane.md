---
type: task
blocking: 04
status: open
---

# 03 — Directory-recursive retrieval lane over resource rows

## Question
Does the upstream heap algorithm (global L0/L1 seed pass → per-directory scoped child search → parent→child score propagation → convergence) beat plain flat KNN over the same rows, enough to justify its lane?

## What to build
`resource-query` gains the recursive mode: embed the query once; global KNN over level∈{0,1} seeds a best-first max-heap of directories; per round pop ≤4 directories, run KNN scoped to their direct children (`WHERE parent = $uri`), combine `α·child + (1−α)·parent`, re-enqueue only directory rows, stop on ≤3 unchanged-top-k rounds or 3 stagnant rounds. Results carry uri + level + abstract preview + the descent trajectory (which path produced each hit). Tiered loading: `--tier 0|1|2` promotes lazily (L2 reads the file). The zettel `card` retrieval path and its default are untouched. α measured here (start 0.5, ablate 0.3/0.7).

## Acceptance
- [ ] Fixture-tree tests: heap order, propagation arithmetic, convergence bound, trajectory recorded, L0/L1-only re-enqueue invariant
- [ ] USB4 smoke: a chapter-level question (e.g. "where is CLx power management defined") returns the right directory subtree + leaf, trajectory inspectable (recorded)
- [ ] α ablation numbers recorded; lane is opt-in (`--mode recursive|flat`), no default change anywhere
- [ ] Hermetic unit tests (no live Surreal) via `_testEmbedder`/`_hierClient` hermeticity pattern; scratch-db integration test skips under CI
- [ ] Canonical `bun run test` green; reviewer pass (or disclosed inline fallback)
