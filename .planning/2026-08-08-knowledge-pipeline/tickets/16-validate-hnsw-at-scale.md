---
type: research
status: closed
claimed: pi/main-session (2026-08-12, ticket 16 research)
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

## Resolution (closed 2026-08-12 — HNSW scale benchmark)

**Verdict: HNSW HOLDS at scale.** Decision 04's ~13ms p95 @1k is confirmed and scales gracefully. The 2026-08-12 self-reflection's "kp-14-vs-perf tension" was based on the 2026-08-07 **FTS/lexical** measurement (SurrealDB 10–50× slower than SQLite) — that does **not** apply to the vector/HNSW path, which is RTT-floor-bound, not O(N)-scan-bound.

**Measured warm single-query p95** (real `SurrealClient`, HTTP RTT included; EF=100, k=10, 200 queries):

| scale | HNSW p95 | cosine p95 | HNSW build |
|---|---|---|---|
| 1k   | 10.97 ms | 1.16 ms | 0.66 s |
| 10k  | 13.44 ms | 6.34 ms | 6.4 s  |
| 100k | 17.96 ms | 66.0 ms | 65 s   |

- HNSW single-query p95 is **flat / RTT-floor-bound**: only 1.64× across a 100× corpus. Cosine is strictly O(N).
- **Crossover (single):** between 10k and 100k — at 100k HNSW is 3.7× faster.
- **Under concurrency (c16 @100k):** HNSW 49 ms vs cosine 1,037 ms — HNSW's server-side parallelism wins decisively (21×).
- **Build cost:** ~1,540 vectors/s flat. Cheap (100k in 65s).
- **⚠ Cold-start caveat:** the FIRST query after a fresh build/restart stalls (12ms @1k, but 2.4s @10k, 3.8s @100k) until warmup. Steady-state (above) is fine; a freshly-built/restarted index needs a warmup pass.

**Implication for ticket 14:** BUILD the full HNSW — it's the scalable path (cheap build, flat ~18ms warm p95, large concurrency wins). RETAIN the cosine JSON-cache fallback (T5) for (a) the small-N regime below the crossover (~10–30k) and (b) the cold-start window after build/restart. **One residual judgment for 14's scope:** if the realistic knowledge-card corpus is expected to stay <~10k with low concurrency, cosine-alone is currently faster per-query and HNSW's value is future-proofing — confirm the expected scale/concurrency before committing the build cost.

**Premise correction of record:** the 2026-08-12 self-reflection's #1 finding ("kp-14-vs-perf tension") conflated FTS latency with vector latency; measurement shows vector/HNSW latency does NOT share the FTS pathology. Resolved in HNSW's favor at scale.

**Artifacts:** `bun-apps/pi-agent-ext-hermes-memory/bench/hnsw-vs-cosine.ts` + `bench/results/hnsw-vs-cosine-20260812-205118.md`.
