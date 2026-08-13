## Task 1 — Surface contentHash on the warm path

Augment the HNSW knn path to return `contentHash` and thread it into `SemanticSearchHit`.

- `src/store/surreal/vector-store.ts`: change the `knn` SELECT to `SELECT mdId, kind, contentHash FROM card_vectors WHERE vec <|${k},${ef}|> $q`; extend `VectorKnnHit` with `contentHash?: string`; map it through.
- `src/store/semantic-search.ts`: add `contentHash?: string` to `SemanticSearchHit`; populate it in `toHit`.
- TDD (red-green) in `tests/store/semantic-search.test.ts`: a warm-path test asserting the returned `SemanticSearchHit` carries the `contentHash` from the fake vector store's knn result. (The fake `VectorKnnHit` must include `contentHash`.)

