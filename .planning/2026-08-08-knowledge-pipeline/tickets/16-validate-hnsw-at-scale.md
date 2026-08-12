---
type: research
status: open
claimed:
blocked by:
unblocks: 14 (full HNSW build — T1+ gates on scale validation)
---
# 16 — Validate SurrealDB HNSW p95 at scale + under load before the full embed-index build

> **Scope guard (do NOT re-litigate the backend choice):** Decision 04 (Round-2) already pinned SurrealDB HNSW as the primary vector store — measured **~13ms p95 @1k 768-dim vectors**, sqlite-vec DROPPED, with a T5 zk JSON-cache brute-force-cosine fallback when SurrealDB is down. This ticket does NOT reopen that. It stress-tests ONE newly-relevant assumption at scale.

## Question / scope

The 2026-08-07 dedup effort (`.planning/2026-08-07-how-is-current-memory-finding-duplicate-conflict/`) measured SurrealDB at **10–50× slower than SQLite on p95 search** (HTTP RTT dominates) — on the *memory-search* path. That data postdates Decision 04. Before committing to the full ticket-14 HNSW build (T1+), validate that the HNSW ~13ms p95 **holds at scale (≫1k vectors) and under concurrent load**, or whether SurrealDB's RTT overhead makes the T5 JSON-cache fallback the de-facto query path (rendering the upfront HNSW build low-value).

This is research (a benchmark), not a build. Output: a measured p95 latency curve for HNSW at 1k / 10k / 100k vectors (single + concurrent) vs the T5 JSON-cache cosine fallback at the same scales, on the real corpus. Decision it feeds: is the full HNSW build (T1–T6) worth it, or should 14 be descoped to "lazy backfill + JSON-cache fallback only"?

## Verification

- [ ] Benchmark script committed; p95 reported at 1k / 10k / 100k for both HNSW and JSON-cache, single + concurrent.
- [ ] One-paragraph verdict: HNSW holds at scale | degrades → fallback de-facto | mixed.
- [ ] If degraded: a follow-up grilling ticket is spawned to decide 14's scope (not resolved here).

## Notes

- Respects Decision 04's backend pin + T5 fallback; only stress-tests its measured assumption with newer data.
- Coordinate with the dedup effort's near-dup tuning (0.6→0.3–0.4) — both touch the dedup/query layer.
