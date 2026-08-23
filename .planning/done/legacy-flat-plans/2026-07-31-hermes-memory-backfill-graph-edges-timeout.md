# Plan: hermes-memory startup — fix backfillGraphEdges 10s timeout

**Date:** 2026-07-31 · **Branch:** dedicated PR branch from `origin/main` (SDD on `wip/next`) · **Diagnosis:** `.planning/2026-07-31-why-startup-s2-agent-sh-so-slow/map.md`

## Context — the REAL startup bottleneck (found after the sync fix)

`./pi-agent.sh` startup is ~10.6s. PR #971 fixed `syncMarkdownMemories` (317→3 Surreal round-trips, 6.3s→100ms) — real but **orthogonal**; startup stayed 10.6s. A step-timed probe of `createBackendBundle` (surrealdb branch) localized the 10s to **one query that times out at the 10s request ceiling on every boot**:

`surreal-memory-repo.ts` `backfillGraphEdges()` runs on every startup and its orphan-check
```sql
SELECT seq, project, target, category FROM memories WHERE id NOT IN (SELECT VALUE in FROM tagged);
```
**times out at 10000ms** (verified on live data: 1227 memories × 30144 tagged edges, `tagged.in` unindexed, and SurrealDB does NOT optimize `NOT IN (subquery)` even when the field is indexed — confirmed by adding the index and re-timing: still 10001ms). The timeout is swallowed by `backfillGraphEdges`' `try/catch` (returns 0), so it is a silent 10s no-op every boot.

**Validated fix (live probe):** the graph-walk rewrite `WHERE count(->tagged) = 0` returns the same orphans in **17ms**.

## The fix

1. **Rewrite the orphan-check query** in `backfillGraphEdges` (`surreal-memory-repo.ts:~699`): `WHERE id NOT IN (SELECT VALUE in FROM tagged)` → `WHERE count(->tagged) = 0`. Keep the same selected columns (`seq, project, target, category`). Semantically equivalent (a memory is a tagged-edge source iff it has an outgoing `->tagged` edge). **10s → 17ms.**
2. **Add an index** `DEFINE INDEX IF NOT EXISTS tagged_in ON TABLE tagged FIELDS in;` to `schema.ts` (near the existing indexes, after the `tagged` table DEFINE). This does NOT help the `NOT IN` (proven), but it speeds the per-edge `DELETE FROM tagged WHERE in = …` queries in `syncGraphEdges` (`:251`/`:667`) and the batch path — beneficial as the corpus grows.
3. **Test** in `tests/store/surreal/surreal-memory-graph.test.ts`: `backfillGraphEdges` finds orphan rows (memories with no edges), rebuilds their edges, and is idempotent on a second call (no new edges). (The 10s timeout only manifests on large corpora; a unit test on a small corpus can't reproduce it — correctness is the testable invariant. The perf is validated by the controller's live probe, documented in the report: 10001ms → 17ms.)

## Out of scope (follow-ups)

- **Sentinel to skip backfill after first successful run** — once graph-augmented search has healed all rows, the check is pure overhead. Add only if the (now-fast) check + rebuild still does non-trivial work every boot (the probe found 944/1227 memories orphaned, so backfill will do real rebuild work until it converges — investigate why edges don't stick if it never converges).
- **The 944-orphan mystery** — why 944 of 1227 memories lack edges despite 30144 existing tagged edges (possible over-creation / record-id mismatch). Separate data-quality investigation.
- **D — 120s lock-contention** between concurrent sibling agents (separate effort).
