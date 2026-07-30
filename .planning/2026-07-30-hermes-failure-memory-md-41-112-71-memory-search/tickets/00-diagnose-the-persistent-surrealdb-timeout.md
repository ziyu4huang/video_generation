## Question

Diagnose **why `memory_search` persistently times out (10s `SurrealDB request timeout`**), and confirm whether the SQLite `sessions.db` is searched or is a pure shadow store. The fix (ticket 01) cannot be chosen until the cause is isolated.

**Findings to date (don't redo these — 2026-07-30):**
- Timeout is **persistent**, not transient — reproduced twice across the session; not a 4-session load spike (SurrealDB process sits at 0.6% CPU when idle).
- SurrealDB **server is healthy**: `surreal start --bind 127.0.0.1:8000 rocksdb:/opt/homebrew/var/surreal.db`, 3-day uptime, 129 MB rocksdb, 2 GB RSS, not crashed/pegged. NS `user_huangziyu`, DB `memory`.
- `memory_search` → `memoryRepo.searchMemories` → SurrealDB backend (the timeout names SurrealDB). The SQLite `sessions.db` is written (`memory-tool.ts`) but does not appear to be the search path.

**Investigation to complete:**
1. **Isolate server-vs-client.** Query SurrealDB directly with the correct NS/DB (`user_huangziyu` / `memory`) — does a direct query (count, or the actual search query) respond fast or also hang? (Fast → the agent's surreal CLIENT/connection is the problem, e.g. a stale 3-day-old connection pool; slow → a query/index/graph issue in surreal itself.) NOTE: the `surreal sql` CLI on this machine rejects `--conn` and the positional query — use `-e <url> -u root -p root` + query via stdin/`-q`, and the `--ns`/`--db` (or `--namespace`/`--database`) flags; verify with `surreal sql --help`.
2. **Inspect the search query path.** Read `memory-search-tool.ts` → `MemoryRepository.searchMemories` → the surreal backend's actual query (`store/surreal/`). Is it a full-table scan, a graph traversal, or an index miss? Has the edge/record count grown over 3 days?
3. **Confirm SQLite's role.** Does any search path read `sessions.db`, or is it write-only shadow (migration residue)? (`grep` the search/backend selection in `store/` + `index.ts`.) This decides whether the "112 orphans" matter at all.
4. **Check the surreal client lifecycle in the agent.** Is the connection established once at extension load (3 days ago) and never reconnected? A stale connection after a long uptime is a prime suspect.

**Output:** a root-cause verdict (server query slow / agent client stale / connection-pool issue / index-graph growth) + the recommended fix direction for [01](01-apply-the-targeted-fix.md).

**type:** research
**blocked by:** _(none — flagship frontier ticket)_
**claimed:** wayfind-session (2026-07-30) — ✅ CLOSED

## Resolution — root cause: `fetchGraphNeighbors` nested `IN (SELECT…)` subquery (NOT server / client / index)

**Root cause.** `SurrealMemoryRepository.fetchGraphNeighbors` (`surreal-memory-repo.ts`) builds the graph-neighbor fetch as a 3-level nested subquery —
`id IN (SELECT VALUE in FROM tagged WHERE out IN (SELECT VALUE id FROM tag WHERE key IN $keys))`.
SurrealDB's planner pathologically under-optimizes this nested `IN (SELECT…)` shape: it hangs **~8–16 s** (verified twice, rc=28 curl-timeout), every call. `memory_search` = fast FTS step (`content @@ $q`, 0.034 s, returns rows) **→** `fetchGraphNeighbors` hangs → the 10 s `memory_search` limit fires. So search always dies at the **graph-augmentation** step.

**Exonerated (all measured live).** SurrealDB server (responds in µs–ms, 0.6 % CPU, 3-day uptime, healthy); the FTS lexical query (`memory_fts` index, 0.034 s); the agent's WS client (not the issue — direct HTTP queries all return fast); data volume (1,058 memories / 30,325 tagged edges / 41k messages — moderate); indexes (adding `tagged.out` + `tag.key` did **not** help — still 16 s; the planner can't optimize the shape regardless of indexes).

**Fix direction (confirmed fast, self-contained — for [01]).** Rewrite `fetchGraphNeighbors` to SurrealDB's **native graph traversal** instead of the nested subquery:
`WHERE … seq NOT IN $seedSeqs AND array::intersect(->tagged->tag.key, $keys) != []` → **0.051 s / 20 rows, ~300× faster**, verified with **no indexes** (the rewrite alone suffices). No schema change needed.

**Side finding (not the cause).** SurrealDB `memories` = 1,058 rows vs `failures.md` = 52 — the SurrealDB table indexes **all** targets (memory/user/failure) and has drifted ahead of the trimmed `.md`. The SQLite `sessions.db` "112 orphans" are confirmed a **harmless shadow store** (search never reads it) — left, per the destination decision. Both feed the deferred "drift-detection" prize.

**type:** research
