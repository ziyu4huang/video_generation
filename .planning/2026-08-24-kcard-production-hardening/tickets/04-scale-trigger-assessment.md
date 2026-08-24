---
type: task
status: closed
closed: 2026-08-24
---

# 04 — SurrealDB scale-trigger assessment (D03 nearing)

## Question

Have card/relation counts crossed the knowledge-pipeline D03 thresholds (≈2k cards / ≈5k relations) now that Core-5 ingest lanes are live, and what relation-index decision does that force?

## What to build

A measured assessment against the live `context_db`: active card count (leaves + agg), relation count, index sizes, and the D03 verdict. If under threshold: record the headroom and the re-check trigger. If over (1925 cards at effort-open, extraction lanes now writing): write the relation-index decision (or fold the work back to the knowledge-pipeline effort with a cross-effort link) — per-level BFS cost was measured fine at ticket 03, but the trigger exists for a reason.

## Verdict — UNDER, no relation work needed

Measured receipt (read-only queries against the live SurrealDB `user_huangziyu` ns / `context_db`, 2026-08-24, script `output/scale-assess-20260824.ts` scratch):

| Metric | Live value | D03 trigger | Headroom |
|---|---|---|---|
| card total | **61** (61 leaves, 0 agg nodes) | ≈2,000 | ~33× |
| relation | **0** | ≈5,000 | writer not yet emitting |
| usage | **0** | — | ledger empty (feeds 03's D4-defer evidence) |
| vaultFingerprint cost @ 61 cards | **0.74–1.01 ms** (3 runs, min 0.72 / median 1.01 first pass, 0.74 second) | — | closes the ticket-02 receipt at the found scale |
| full count query batch | 35–40 ms | — | — |

Index inventory (INFO FOR TABLE): `card` has all 8 D21 indexes live (FTS body/summary/title, plain is_leaf/kind/parent/stem, HNSW `card_vec`); `relation` has none (defined + empty, consistent with D11 status). Gate-side live fingerprint == `index_meta.fingerprint` (`03f51319…`, card_count 61, bge-m3 dim 1024) — index fresh at measurement time.

**The 1925-card figure is stale**: it was the parity-effort-open receipt (older vault state); the live vault's `Zettelkasten/knowledge-graph` folder holds 61 md files and the index agrees (61 rows, fp match). Extraction lanes writing (ticket 01 drain) have not approached the trigger.

Re-check trigger (when this verdict expires): re-assess when a rebuild stamps `index_meta.card_count ≥ 1,500` (75% of the card trigger), when a relation writer goes live (relation count > 0 makes the ≈5k trigger reachable), or at the next kcard scale-touching effort — whichever comes first.

## Acceptance

- [x] Measured count receipt from the live index (card/relation/size, date-stamped) — table above, 2026-08-24
- [x] D03 verdict recorded in the map: under (headroom + re-check trigger) — map Context + Frontier updated
- [x] No code unless the verdict is over — verdict under; no code, assessment-only commit
