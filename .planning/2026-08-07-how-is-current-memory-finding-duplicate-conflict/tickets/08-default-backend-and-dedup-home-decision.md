type: grilling
blocked by: 01-dedup-conflict-cross-backend-consistency, 06-build-backend-ab-harness, 07-build-golden-dedup-corpus

## Question

The terminal decision this map exists to reach: (a) which backend ships as the default memory store (disk-`MEMORY.md` / SQLite / SurrealDB), grounded in 06's measured numbers; (b) given that, where does dedup/conflict detection *live* going forward — MD-layer-only, promoted into the shared `MemoryRepository` contract, or DB-native (esp. for SurrealDB)? Decide the canonical source-of-truth (MD vs DB) as part of this. Resolving this closes the map and hands off to a Superpowers writing-plans effort for execution.

## Perf input resolved (06 closed, 2026-08-07)

Backend-perf question DECIDED by measurement: SurrealDB is 10-50x slower than SQLite on p95-search (server/HTTP-RTT vs embedded); keep SQLite as the default memory backend. Also: surreal `syncMemoryEntriesBatch` has an OR-chain parser-recursion bug at scale. So part (a) of this ticket — "which backend ships as default" — is effectively answered: SQLite. Remaining for 08 when it runs: part (b) where dedup/conflict detection lives (MD-layer-only vs promoted into the shared MemoryRepository contract — see 01's blind-`addMemory` double-persist gap), and the canonical source-of-truth question. 08 is now blocked only by 07 (the dedup baseline).

## Resolution (closed 2026-08-08 — superseded)

Superseded by effort 2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or (ticket 01), which generalizes the memory system into a card-agnostic knowledge pipeline and resolved all three of this ticket's questions:

- **Where dedup/conflict lives** — RESOLVED by 2026-08-08/01: dedup/conflict is PROMOTED into the (now card-agnostic) store contract as ONE call-site behind a pluggable strategy interface (default = exact/near-dup/topic/merge-plan; knowledge-cards register zk's 4-layer strategy). No longer MD-layer-only; the blind addMemory double-persist gap (found by this effort's 01) is closed by the strategy seam.
- **Canonical source-of-truth** — MD stays canonical (carried forward; the store mirrors to DB). Unchanged.
- **Default backend** — SQLite won for the MEMORY workload (this effort's 06: SurrealDB 10-50x slower on FTS). The generalized system reopens this for the knowledge/embed workload: 2026-08-08 develops BOTH SQLite (sqlite-vec) + SurrealDB (native embed) and decides by A/B. So "default backend" is no longer a standalone decision here — it is pending the 2026-08-08 A/B.

Net: this effort (2026-08-07) is ABSORBED by 2026-08-08. Its findings (06 perf win, 07 dedup baseline, MD-canonical) carry forward as locked context in the 2026-08-08 map. Ready for /wayfind done.

closed: 2026-08-08 (superseded by 2026-08-08/01; effort absorbed; ready for /wayfind done)
