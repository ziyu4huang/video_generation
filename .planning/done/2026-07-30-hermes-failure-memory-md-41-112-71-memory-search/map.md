---
status: complete
---

> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — make hermes `memory_search` reliable (fix the persistent SurrealDB timeout)

## Destination

`memory_search` reliably fast again — no 10s `SurrealDB request timeout`. The 3-tier store is understood and the active-search path (SurrealDB) fixed. The SQLite `sessions.db` shadow store's drift (112 rows vs 52 `.md`) is documented but **left** — it does not affect search (destination decision: reliability-first).

> **Premise shift.** The originating ticket framed this as "reconcile the DB search index (112 vs 41 orphans)." Investigation reframed it: hermes has a **3-tier store** — `failures.md` (source of truth) + SQLite `sessions.db` (a diverged shadow store, written but evidently not the search path) + **SurrealDB** (RocksDB @ 127.0.0.1:8000, the *active* search backend `memory_search` queries — and the thing timing out). The "112 orphans" are a shadow store that doesn't affect search; the real problem is the SurrealDB timeout.

## Notes

**Architecture (verified 2026-07-30).**
- `~/.pi/agent/pi-hermes-memory/failures.md` — source of truth (global, 52 entries, `§`-delimited). Other live sessions write to it (grew 41→52 during this session).
- SQLite `sessions.db` — a `memories` table (project/target/category/content/…); **112 failure rows, all `project=null`, content diverged from the `.md`** (0 of the `.md`'s entries match). Written by `memory-tool.ts` (`sqliteProjectFor`/`sqliteTargetFor`) but `memory_search` does **not** appear to query it (search goes through `memoryRepo.searchMemories` → SurrealDB). Likely a shadow/legacy/migration store. **Confirm in ticket 00.**
- SurrealDB — `surreal start --bind 127.0.0.1:8000 rocksdb:/opt/homebrew/var/surreal.db`; NS `user_huangziyu`, DB `memory` (per `per-user-db.ts` `derivePerUserNamespace`). 129 MB rocksdb; process healthy (0.6% CPU, 3-day uptime, 2 GB RSS — not crashed/pegged). `memory_search` times out here (10s, **persistent** — reproduced twice).

**Live sessions (execution context).** 4 pi-agent processes: `superpowers` (this), `__memory`, `__subagent`, `__file2md`. The timeout reproduces regardless, so it is not simple concurrent-load throttling.

**Skills every session should consult.** `systematic-debugging` (this is a diagnose-then-fix), `grilling` (if the fix is a judgment call).

## Decisions so far

- [00 Diagnose the persistent SurrealDB timeout](tickets/00-diagnose-the-persistent-surrealdb-timeout.md) — **DONE (research)**: root cause = `fetchGraphNeighbors`'s nested `IN (SELECT…)` subquery over the `tagged` edge table (~8–16 s; SurrealDB's planner can't optimize the shape — indexes don't help). Server / FTS / WS-client / data-volume all **exonerated** by live measurement. Fix = rewrite to native graph traversal `array::intersect(->tagged->tag.key, $keys) != []` (0.051 s, ~300× faster, no schema change). The SQLite shadow-store "112 orphans" confirmed harmless (search never reads them).
- [01 Apply the targeted fix](tickets/01-apply-the-targeted-fix.md) — **DONE (task)**: rewrote `fetchGraphNeighbors` to native graph traversal. `memory_search` now **25–39 ms** (was 8–16 s timeout) vs live data. Verified TDD RED→GREEN (contract test) + graph-recall semantics + end-to-end + tsc. **Map complete (2/2).**

## Not yet specified

- **A durable drift-detection / reconcile mechanism** for the dual-backend (SQLite shadow vs `.md` vs SurrealDB) — so divergence is caught, not silently accumulated. Graduates only after ticket 00 confirms which stores are authoritative.
- **Whether the SQLite shadow store should be retired** entirely (if ticket 00 confirms it is never searched) — removes a confusing divergent store. Graduates from 00's findings.

## Out of scope

- **Cleaning the SQLite 112 rows** — shadow store, doesn't affect search (destination decision: reliability-first). Revisit only if 00 finds it IS searched.
- **A general hermes storage overhaul / backend unification.** Touching the dual-backend architecture is a separate, larger effort.
- **The `.md` content itself** — already cleaned this session (96%→~82%); not the problem here.
> Closed 2026-08-15: memory_search SurrealDB timeout fixed; shadow-store drift documented as left-by-decision.
