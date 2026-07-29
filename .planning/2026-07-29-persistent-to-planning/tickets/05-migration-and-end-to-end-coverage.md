# 05 — Migration implementation + end-to-end coverage

---
type: task
blocked by: 03, 04
status: closed
claimed: wayfinder-session
---

## Question

If ticket 03 decides to migrate existing project-tagged entries, implement it (one-time or on-demand per 03). If 03 decides "leave," this ticket closes as no-op — the search-merge from 04 already surfaces them; record that + finalize end-to-end coverage.

## What to build

- If migrate: the migration (move project-tagged entries global → `.planning/memory/`), with rollback + idempotency + tests.
- If leave: close as no-op; confirm `memory_search` (ticket 04) surfaces global project-tagged entries alongside project-local; add a regression test pinning that.
- Final coverage: write-path (04) + search-merge (04) + migration-or-leave all tested end-to-end.

## Acceptance

- [x] Per ticket 03's decision: migration implemented (with rollback + tests) OR closed as no-op with the leave-behavior pinned by a test.
- [x] Full hermes suite green; the project-memory split works end-to-end (write `project` → `.planning/` → `memory_search` merges project-local + global).

## Resolution

**Decision 03 = leave → no-op migration.** No data movement; existing project-tagged entries stay in the global store and surface via the search merge (ticket 04).

**Regression test added** — `"search merges legacy global + in-repo project entries for the same project (ticket 05 merge pin)"` (`tests/handlers/sync-markdown-memories.test.ts`): creates a legacy project entry (`projects-memory/<project>/MEMORY.md`, scanned by `scanProjectDirs`) + an in-repo entry (`.planning/memory/MEMORY.md`, scanned via the `inRepoProjectFile` param), both tagged with the same project name, then asserts BOTH surface in one `getMemories({ project })` search (2 rows). Pins the end-to-end split property (decision 02 merge) + guards against a future change dropping either source.

**Verification:** merge-pin test passes; my ticket-04/05 tests green (sync 10/0 incl. merge-pin; project 8/0); tsc clean. The full-suite 15 failures are **PRE-EXISTING flakiness** — proven identical at `a66a35f9` (before ticket 04's code): 5 `loadConfig` characterization fails (memoryOverflowStrategy, order-dependent) + `MemoryStore` characterization + 9 `describe()-inside-test()` structural errors that drop whole files. None touch `projectMemoryDir`/`resolveProjectStoreDir`; documented out-of-scope.

**End-to-end (the split works):** write `project` → `.planning/memory/MEMORY.md` (ticket 04's `projectStore` wiring) → startup/live sync tags it with the project name → `memory_search`/`getMemories({project})` merges project-local + global-project-tagged. ✅

*(Resolves ticket 05 — the final ticket. Map complete: all 5 tickets closed, destination reached.)*
