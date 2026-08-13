# Task 1 Report — Surface contentHash on the warm path

Ticket 19 (LeanRAG redundancy-aware retrieval, dedup-first slice), Task 1 of 3.
Package: `bun-apps/pi-agent-ext-hermes-memory`. Branch: `feat/kp-19-leanrag-redundancy-aware-retrieval`.

## What I implemented

Surfaced `contentHash` from the `card_vectors` HNSW side-table through the warm
semantic-search path, so Task 2 can dedup hits by exact content hash.

1. **`src/store/surreal/vector-store.ts`**
   - `VectorKnnHit` gained `contentHash?: string` (optional — cold path doesn't carry it).
   - The `knn` SELECT changed from `SELECT mdId, kind FROM card_vectors WHERE vec <|k,ef|> $q`
     to `SELECT mdId, kind, contentHash FROM card_vectors WHERE vec <|k,ef|> $q`.
   - The row→hit `map` sets `contentHash` **only when the row provides it**
     (`if (r.contentHash !== undefined) hit.contentHash = r.contentHash`), so a
     hashless row (older rows / mocks) stays shape-compatible.

2. **`src/store/semantic-search.ts`**
   - `SemanticSearchHit` gained `contentHash?: string` (optional).
   - `toHit` populates `contentHash` **only when the knn hit provides it**
     (`if (h.contentHash !== undefined) hit.contentHash = h.contentHash`),
     keeping hashless warm hits shape-compatible with the existing `toEqual` asserts.

3. **`tests/store/semantic-search.test.ts`** — new warm-path test asserting the
   returned `SemanticSearchHit` carries `contentHash` from the fake vector store's
   knn result, and that a hashless knn row produces a hit with NO `contentHash` key.

No new throw paths. No dedup logic, no config knobs (those are Tasks 2/3 — YAGNI).

## TDD evidence

### RED (test first, then watch it fail for the right reason)

Command:
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/semantic-search.test.ts )
```

Relevant failing output:
```
expect(received).toEqual(expected)

  [
    {
-     "contentHash": "hash-1",
      "kind": "memory",
      "mdId": "m1",
+     "score": undefined,
      "source": "hnsw",
    },
    ...
  ]
(fail) searchSemantic — warm path (T2) > surfaces contentHash on the warm path when knn provides it (Task 1)
 12 pass
 1 fail
```

Why the failure was expected: `contentHash` was NOT surfaced on the warm hit —
`toHit` did not map it through, so the expected `contentHash: "hash-1"` was absent
on `m1`. (The `+ score: undefined` lines are bun's diff-display artifact —
`toEqual` ignores `undefined`-valued properties, as the existing "returns HNSW
hits ranked" test passing in the same run confirms.)

### GREEN (minimal implementation)

Command:
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/semantic-search.test.ts )
```

Relevant passing output:
```
(pass) searchSemantic — warm path (T2) > surfaces contentHash on the warm path when knn provides it (Task 1) [0.22ms]
 13 pass
 0 fail
```

## Files changed

```
 bun-apps/pi-agent-ext-hermes-memory/src/store/semantic-search.ts                      | 10 +++++++++-
 bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/vector-store.ts                 | 16 +++++++++++++---
 bun-apps/pi-agent-ext-hermes-memory/tests/store/semantic-search.test.ts              | 15 +++++++++++++++
```

## Self-review

- **Completeness vs brief:** all four brief items done — knn SELECT augmented,
  `VectorKnnHit.contentHash?` added + mapped, `SemanticSearchHit.contentHash?`
  added, `toHit` populates it. ✅
- **contentHash is OPTIONAL:** declared `?` on both interfaces; populated only
  when the knn row provides it. The cold fallback paths (memory-lexical /
  zk-semantic) never set it — never required, never synthesized. ✅
- **Never throws:** the change adds zero throw paths. `knn` still returns `[]`
  on a non-array response; `toHit` is pure. ✅
- **Shape-compatibility (brief heads-up):** the conditional assignment meant NO
  existing `toEqual` assertion needed updating — hashless warm hits keep their
  exact pre-change shape. Confirmed by the full suite (no assertion breaks). ✅
- **YAGNI:** no dedup, no config knobs — only what Task 1 needs. Dedup is Task 2,
  knobs are Task 3. ✅
- **Test verifies real behavior:** the new test exercises both the with-hash and
  hashless knn rows through the real `searchSemantic` warm path, asserting the
  real `toHit` mapping (not a mock). ✅
- **Naming/docs:** comments reference ticket 19; field doc-comments explain
  optionality and the cold-path carve-out. ✅

## Full-suite result

```
( cd bun-apps/pi-agent-ext-hermes-memory && bun run check )   # tsc --noEmit → clean
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
 1514 pass
 1 skip
 0 fail
 1151 expect() calls
 Ran 1515 tests across 131 files. [14.49s]
```

Baseline was **1513 pass / 1 skip / 0 fail**; this change lands at **1514 pass /
1 skip / 0 fail** (+1 = the new warm-path contentHash test). Output pristine.
