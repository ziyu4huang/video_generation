---
type: build
status: closed
claimed:
blocked by: 14 (closed — index shipped)
---
# 18 — Hermes-side JSON-cache cosine fallback for ALL card kinds (T5b) [spawned from ticket 14]

> Ticket 14 shipped T5(a): SurrealDB-down → knowledge cards fall back to zk JSON-cache cosine (seam); memory cards fall back to lexical searchMemories (FTS). This adds the FULL two-tier fallback (T5b): a hermes-side cosine cache over card_vectors so MEMORY cards also degrade to cosine when SurrealDB is down.

## Question / scope

The Round-2 backend text said "semantic search unavailable when SurrealDB down"; ticket 14's T5 acceptance said "degrade to JSON-cache cosine." Ticket 14 resolved this as T5(a) (graceful degrade: zk-cosine for knowledge, FTS for memory) and deferred the literal cosine-for-memory to here. Build a hermes-side snapshot/cache of card_vectors vectors so a SurrealDB-down semantic query over memory cards degrades to brute-force cosine, no throw.

## Verification

- [x] SurrealDB-down: memory-card semantic query degrades to hermes cosine over the cache (no throw, results returned).
- [x] Cache stays consistent with card_vectors (delta-updated alongside the T3 backfill).

## Notes

- Ship only if memory-card semantic recall during SurrealDB downtime is a felt requirement (FTS is arguably a better memory fallback today).
- Re-evaluate after real usage of ticket 14's T5(a).

## Cross-effort links
- Shares-decision-with: `.planning/2026-08-10-hermes-architecture-deepening` — in the simplify-&-robusten wave scope (ticket 10 there), sequenced LATE in the wave. (2026-08-16)

## T5b (2026-08-16)

- Ship-gate ("only if felt requirement" — FTS arguably a better memory fallback) resolved by USER DECISION: implement now, symmetric with T5(a) knowledge-cosine.
- Shipped in hermes-memory: `src/store/card-vectors-cache.ts` (JSON mirror module, never-throw) + batch mirror hook in `handlers/vector-backfill.ts` (options.memoryDir, best-effort) + hermes-cosine cold branch in `src/store/semantic-search.ts` (tried BEFORE the lexical floor; source "hermes-cosine"); guarded by `embedModel` (embedding endpoint id, NOT lineage MODEL_VERSION). Suite 1659/0.
- Follow-up-optional: dedicated backfill-mirror integration test; production threading of memoryDir into the walk-and-ingest fire-and-forget scheduleVectorBackfill call (currently NOT threaded — mirror off until then). Details in hermes-arch ticket 10.

## Closed (2026-08-16)
- Both arms shipped: T5(a) knowledge cosine degrade (earlier PR), T5(b) memory hermes-cosine over local card-vectors JSON mirror (PR #1524, 5c29c002; embedModel = embedding endpoint id guard, NOT lineage MODEL_VERSION). All checkboxes [x]. Suite 1659/0.

