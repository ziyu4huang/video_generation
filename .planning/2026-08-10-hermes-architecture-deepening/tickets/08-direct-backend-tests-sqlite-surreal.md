---
type: task
status: closed
claimed:
blocked by: 06 (C3 sqlite-backend split)
---
# 08 — Direct backend tests: sqlite + surreal

`src/store/sqlite` and `src/store/surreal` currently have ZERO direct tests — all coverage is indirect through higher layers.

## Acceptance
- Direct suites for both backends (real round-trips: write/read/migrate/delete), not mocks-of-mocks.
- Robusten-scope item (grilling 2026-08-16), paired with ticket 09 (SurrealDB-down hardening).

## Notes
- Sequenced after C3 (ticket 06) so the suites test the split shape, not the monolith.

## Closed (2026-08-16 — audit: direct suites pre-existed, premise stale)
- Audit matrix: 10 pre-existing direct suites under tests/store/ (surreal: client, backend, memory-graph, memory-graph-query, memory-repo-contract, session-repo-contract, session-repo-backfill, session-repo-incremental, per-user-db, vector-store) + sqlite memory/session repos directly on the split shape — the ticket's "ZERO direct tests" premise was stale.
- Gap filled: tests/store/sqlite-backend.test.ts — SqliteBackend lifecycle suite (healthCheck() PRAGMA quick_check probe + init-idempotent + close-twice safe), 2 tests. The only previously uncovered sub-cell was healthCheck (repository.test.ts only mocks the Backend interface; db.test.ts already owned schema/FTS5/WAL/FK/corruption).
