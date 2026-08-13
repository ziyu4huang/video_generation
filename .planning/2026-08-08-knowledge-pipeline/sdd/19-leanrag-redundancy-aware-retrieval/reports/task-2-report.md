# Task 2 Report — Exact-contentHash dedup + re-rank seam (warm + cold)

Ticket 19 (LeanRAG redundancy-aware retrieval, dedup-first slice), Task 2 of 3.
Package: `bun-apps/pi-agent-ext-hermes-memory`. Branch: `feat/kp-19-leanrag-redundancy-aware-retrieval`.

## What I implemented

A **single private dedup seam** in `src/store/semantic-search.ts`, wired across
all three return paths of `searchSemantic`:

1. **New private helper `dedupByContentHash(hits: SemanticSearchHit[]): SemanticSearchHit[]`**
   - Keeps the **first** occurrence per **DEFINED** `contentHash`.
   - Hits with `contentHash === undefined` are **always kept** (a missing hash is
     never a shared key — Global Constraint).
   - Pure array iteration → **never throws**.
   - No `survivingK`, no `boostWeight` (Task 3 / ticket 20 — YAGNI here).

2. **Warm path** (the `if (vectorStore && embedder)` block): applied to `ranked`
   **before the early return**. The existing mdId-dedup + `excludeIds` + kind-filter
   + topK loop is **untouched**; contentHash-dedup is an additional pass placed
   immediately after it (per brief: "place it sensibly, e.g. after mdId-dedup").
   The Phase-B cold-index trigger is now keyed on the deduped list's length; since
   dedup can only shrink a non-empty list (it keeps the first per key),
   `deduped.length === 0 ⟺ ranked.length === 0`, so the cold-index signal is
   preserved bit-for-bit.

3. **`knowledgeFallback`** and **`memoryFallback`**: applied to their output
   arrays before each `return`. Cold-path hits carry no `contentHash`
   (`RetrievedCard` / `MemoryEntry` lack it), so the pass is a **correct no-op**
   there — every hashless hit survives — but the seam is wired so a future
   hash-bearing cold source needs no caller change.

The helper is **module-private** (per the "single private seam" constraint).
Collapse semantics are proved through the warm path (the task's preferred
alternative to exporting the helper for direct unit testing); the cold path is
proved to be a correct no-op.

## TDD evidence

### RED — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/semantic-search.test.ts )`

Wrote 7 new tests before any production change. The two **warm-collapse** tests
drove the implementation and failed as expected (the no-op/guard tests passed —
correct characterization of pre-change behavior):

```
(fail) searchSemantic — contentHash dedup seam (ticket 19 T2) > WARM: two knn hits sharing a contentHash collapse to one (keeps first)
  expected [m1, m3]; received [m1, m2, m3]  (m2 not yet deduped)
(fail) searchSemantic — contentHash dedup seam (ticket 19 T2) > WARM: a hashed hit dedups against a later same-hash hit, hashless ones untouched
  expected ["m1","m2"]; received ["m1","m2","m3"]  (m3 dup-of-m1 not yet dropped)
(pass) ...5 no-op / guard tests...
18 pass
2 fail
```

The two failures are exactly the collapse semantics the helper must add — RED
confirmed and meaningful (not a typo / harness failure).

### GREEN — same command after adding the helper + wiring

```
20 pass
0 fail
27 expect() calls
Ran 20 tests across 1 file.
```

All 7 new tests green; all 13 pre-existing tests in the file still green.

### Typecheck

`( cd bun-apps/pi-agent-ext-hermes-memory && bun run check )` → `tsc --noEmit`,
**clean** (the package's canonical `check` = tsc).

### Full suite — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`

```
1521 pass
1 skip
0 fail
1158 expect() calls
Ran 1522 tests across 131 files. [14.67s]
```

Baseline was **1514 pass**; now **1521 pass** (delta = +7 new tests). Output
pristine. No regressions.

## Files changed

- `bun-apps/pi-agent-ext-hermes-memory/src/store/semantic-search.ts`
  - + private `dedupByContentHash()` helper (with full doc comment).
  - warm path: `ranked` → `dedupByContentHash(ranked)` before early return;
    trigger keyed on deduped length.
  - `knowledgeFallback` / `memoryFallback`: `dedupByContentHash(hits)` before
    each `return`.
- `bun-apps/pi-agent-ext-hermes-memory/tests/store/semantic-search.test.ts`
  - + new `describe("searchSemantic — contentHash dedup seam (ticket 19 T2)")`
    block: 7 tests (warm collapse ×2, hashless-kept ×1, cold no-op ×2,
    never-throws ×2).

Commit: `fbdd39e1` (staged ONLY these two files; progress.md left gitignored).

## Self-review findings

| Requirement | Status |
|---|---|
| Private `dedupByContentHash(hits): SemanticSearchHit[]` | ✅ |
| Keeps first per DEFINED contentHash | ✅ |
| Hashless hits always kept (never a dedup key) | ✅ tested |
| Applied to warm `ranked` before early return | ✅ |
| Applied to `knowledgeFallback` output | ✅ |
| Applied to `memoryFallback` output | ✅ |
| Single seam (one function, applied in 3 places) | ✅ |
| Preserve mdId-dedup + exclude + kind-filter + topK | ✅ untouched |
| Never-throws (absolute; ticket 14 T5a) | ✅ pure iteration; full try/catch intact |
| contentHash optional / hashless-kept / shape-compatible | ✅ |
| No survivingK, no boostWeight (Task 3 / ticket 20) | ✅ YAGNI honored |
| Tests verify real behavior (not mocks-only) | ✅ warm collapse + cold no-op + never-throws |
| Did not touch callers (knowledge-search-tool out of scope) | ✅ |

**Cold-path ambiguity (resolved per task):** test (b) is a **correct no-op**
test, not a collapse test — cold hits have no contentHash, so the seam runs but
nothing collapses (both knowledge and memory hits survive, no throw). The
meaningful collapse proof is the **warm-path** test (a). This matches the
task's explicit resolution; the cold-path seam exists for forward-compat only.

**Placement note:** contentHash-dedup runs after topK truncation, so a warm
path may return fewer than `topK` hits when dedup collapses a pair. This is
intended for this slice — re-fill / re-rank is Task 3 (survivingK / boostWeight,
ticket 20), correctly deferred per YAGNI. The brief's "place it sensibly, e.g.
after mdId-dedup" guidance is followed exactly.

No concerns. Ready for review.
