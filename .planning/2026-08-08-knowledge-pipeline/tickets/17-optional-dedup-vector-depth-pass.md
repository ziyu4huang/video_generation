---
type: build
status: open
claimed:
blocked by: 14 (closed — index shipped)
---
# 17 — Optional dedup vector depth-pass [spawned from ticket 14 T4]

> Optional refinement of the shipped HNSW index (ticket 14). Ingest dedup stays FTS/hash (unchanged); this adds an OPTIONAL vector near-dup depth-pass once the HNSW index is warm.

## Question / scope

Ticket 14 deferred T4. The ingest path's pluggable `DedupStrategy` stays FTS/hash (ticket-14 acceptance — unchanged when vectors absent). This ticket adds an OPTIONAL depth-pass: once the HNSW index is warm, a candidate card is KNN-queried against the index and flagged as a near-dup above threshold. Coordinate with the dedup effort's near-dup threshold tuning (0.6→0.3–0.4, recall 54.5%→~95%).

## Verification

- [ ] Depth-pass is a no-op when VectorStore unavailable.
- [ ] Flags a near-dup when the index is warm (above threshold).
- [ ] Ingest dedup behavior unchanged when vectors absent.

## Notes

- Coordinate with `.planning/2026-08-07-how-is-current-memory-finding-duplicate-conflict/` near-dup tuning.
- Purely additive — ship only if near-dup recall is a felt problem.

## Cross-effort links
- `.planning/2026-08-10-hermes-architecture-deepening` simplify-&-robusten wave: explicitly NON-blocking — stays open here as an optional refinement. (2026-08-16)
