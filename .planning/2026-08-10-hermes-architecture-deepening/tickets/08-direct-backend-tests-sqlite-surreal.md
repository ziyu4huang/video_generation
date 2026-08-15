---
type: task
status: open
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
