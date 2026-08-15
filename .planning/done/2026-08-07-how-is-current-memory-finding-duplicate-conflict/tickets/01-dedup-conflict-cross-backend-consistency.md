type: research

## Question

Does the memory store apply the *same* duplicate/conflict detection across all three backends (disk-`MEMORY.md`, SQLite, SurrealDB), or is dedup confined to the MD-file `memory-store.ts` layer? Concretely: on `add` through each backend's repository (`addMemory` / `syncMemoryEntry`), is there (a) exact-dup rejection, (b) near-dup warning via `findNearDuplicate`, (c) topic-recurrence via `findTopicRecurrence`? Is the MD store still re-deduped on `loadFromDisk` while the DB is a secondary index? Where exactly do the SQLite and Surreal repos dedup (file:line), if at all — and are there gaps where identical content can be persisted twice via the DB path? Audit `bun-apps/pi-agent-ext-hermes-memory/src/store/` + `tests/store/repository-contract.test.ts` with file:line evidence.

## Resolution

**Dedup is confined to the MD-file layer.** SQLite and SurrealDB are secondary indexes; on `sync*` they do identity-based dedup only (target+project+category+content -> same id), and on `addMemory` they do a **blind INSERT/CREATE with no exact-dup check**. Near-dup (`findNearDuplicate`) and topic-recurrence (`findTopicRecurrence`) are **MD-only and warning-only** (entry is still added).

**Confirmed gaps (file:line):**
- `src/store/sqlite/sqlite-memory-repo.ts:~165` — `addMemory` blind INSERT, no dup check.
- `src/store/surreal/surreal-memory-repo.ts:~334` — `addMemory` blind CREATE, no dup check.
- -> Identical content CAN persist twice if written via `addMemory` (bypassing the MD store). `sync*` is safe; `addMemory` is not.
- Near-dup / topic never imported into either DB repo.

**Source-of-truth:** MD file is canonical — `loadFromDisk()` re-runs `dedupEntries()` every startup; write flow goes MD (`store.add`, gated by exact-dup block) -> then `syncAddToSqlite` to DB (`src/tools/memory-tool.ts:~415-450`). DB is a read/search cache.

**Contract:** `tests/store/repository-contract.test.ts` asserts identity-dedup on `syncMemoryEntry` only — does NOT cover near-dup, topic, or `addMemory` exact-dup.

**Feeds:** ticket 08 (where dedup lives). The `addMemory` blind-insert gap is the strongest argument for promoting dedup into the shared `MemoryRepository` contract. Also sharpens the map fog on canonical source-of-truth: MD is canonical today; whether DB becomes canonical is the 08 decision.

closed: 2026-08-07 (research resolved at chart time)
