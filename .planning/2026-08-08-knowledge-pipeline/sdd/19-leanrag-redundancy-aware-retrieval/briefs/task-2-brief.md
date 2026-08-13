## Task 2 — Exact-contentHash dedup + re-rank seam (warm + cold)

Add a shared dedup helper and apply it on every return path.

- `src/store/semantic-search.ts`: add a private `dedupByContentHash(hits: SemanticSearchHit[]): SemanticSearchHit[]` — keeps the first occurrence per `contentHash`; hits with no `contentHash` are always kept (per Global Constraint). Apply it to the warm path's `ranked` list (before the early return) AND to the output of `knowledgeFallback` and `memoryFallback`.
- Preserve the existing `mdId`-dedup + exclude + kind-filter + topK logic; contentHash-dedup is an additional pass.
- TDD: (a) warm path — two knn hits with the same `contentHash` collapse to one; (b) cold path — duplicate-hash knowledge (or memory) hits collapse; (c) never-throws — dedup over a malformed/empty input returns `[]`/the input unchanged without throwing.

