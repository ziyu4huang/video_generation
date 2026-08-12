---
type: build
status: open
claimed:
blocked by: 14 (closed — index shipped)
---
# 18 — Hermes-side JSON-cache cosine fallback for ALL card kinds (T5b) [spawned from ticket 14]

> Ticket 14 shipped T5(a): SurrealDB-down → knowledge cards fall back to zk JSON-cache cosine (seam); memory cards fall back to lexical searchMemories (FTS). This adds the FULL two-tier fallback (T5b): a hermes-side cosine cache over card_vectors so MEMORY cards also degrade to cosine when SurrealDB is down.

## Question / scope

The Round-2 backend text said "semantic search unavailable when SurrealDB down"; ticket 14's T5 acceptance said "degrade to JSON-cache cosine." Ticket 14 resolved this as T5(a) (graceful degrade: zk-cosine for knowledge, FTS for memory) and deferred the literal cosine-for-memory to here. Build a hermes-side snapshot/cache of card_vectors vectors so a SurrealDB-down semantic query over memory cards degrades to brute-force cosine, no throw.

## Verification

- [ ] SurrealDB-down: memory-card semantic query degrades to hermes cosine over the cache (no throw, results returned).
- [ ] Cache stays consistent with card_vectors (delta-updated alongside the T3 backfill).

## Notes

- Ship only if memory-card semantic recall during SurrealDB downtime is a felt requirement (FTS is arguably a better memory fallback today).
- Re-evaluate after real usage of ticket 14's T5(a).
