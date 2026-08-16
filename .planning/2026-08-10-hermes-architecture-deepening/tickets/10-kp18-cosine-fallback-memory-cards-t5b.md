---
type: task
status: closed
claimed:
blocked by: (none — sequenced late in the wave)
---
# 10 — kp18 cosine fallback for memory cards (T5b) (cross-link)

Work item tracked on the kp map: [kp 18 — hermes cosine fallback, all kinds](../../2026-08-08-knowledge-pipeline/tickets/18-hermes-cosine-fallback-all-kinds.md) (T5b: hermes-side JSON-cache cosine over card_vectors so memory cards degrade to cosine when SurrealDB is down). THIS ticket is the hermes-arch wave entry.

## Sequencing
- In wave scope; sequenced LATE in the wave (after the core sequence 05 → 06 → 07/08).

## Closed (2026-08-16)

- Ship-gate ("only if felt requirement") resolved by USER DECISION: implement now, symmetric with T5(a) knowledge-cosine.
- Key design correction: the guard compares `embedModel` (the embedding ENDPOINT id, types.ts `embedModel`, default nomic-embed-text-v1.5) — NOT the lineage `MODEL_VERSION` — because cosine across different embedding models is garbage.
- Impl: `src/store/card-vectors-cache.ts` (JSON mirror, never-throw load/save/upsert/remove + cosineSimilarity; 4 unit tests); `handlers/vector-backfill.ts` batch mirror hook (options.memoryDir, best-effort); `semantic-search.ts` memory cold path tries hermes-cosine BEFORE the lexical floor (SearchSemanticOptions.memoryDir + warmQueryVec hoist; source "hermes-cosine"); 4 degrade tests in tests/store/semantic-search.test.ts. Suite 1659/0.
- Follow-up-optional: a dedicated backfill-mirror integration test (walk-and-ingest-vector-backfill harness) — hook is tsc-covered + module unit-tested meanwhile.
- Production threading of `memoryDir` into scheduleVectorBackfill callers (walk-and-ingest fire-and-forget): verify on ship; if not threaded, the mirror stays off until threaded — check `grep -n "memoryDir" src/walk-and-ingest.ts src/handlers/vector-backfill.ts` and note the finding in this ticket.
- Caller threading finding: NOT THREADED — walk-and-ingest.ts:298 passes opts.memoryDir into fireVectorBackfillBestEffort (:356, resolves `dir` for createCardStore) but :361-367 calls scheduleVectorBackfill with only the 6 positional args (no 7th options object) → options.memoryDir undefined → the mirror hook (vector-backfill.ts:76,227-230) stays OFF in the production fire-and-forget path until a follow-up threads `{ memoryDir: dir }` in; the hermes-cosine cold path still works whenever the cache file exists.
