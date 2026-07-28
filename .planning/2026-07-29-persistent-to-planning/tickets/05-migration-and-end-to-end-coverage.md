# 05 — Migration implementation + end-to-end coverage

---
type: task
blocked by: 03, 04
status: open
---

## Question

If ticket 03 decides to migrate existing project-tagged entries, implement it (one-time or on-demand per 03). If 03 decides "leave," this ticket closes as no-op — the search-merge from 04 already surfaces them; record that + finalize end-to-end coverage.

## What to build

- If migrate: the migration (move project-tagged entries global → `.planning/memory/`), with rollback + idempotency + tests.
- If leave: close as no-op; confirm `memory_search` (ticket 04) surfaces global project-tagged entries alongside project-local; add a regression test pinning that.
- Final coverage: write-path (04) + search-merge (04) + migration-or-leave all tested end-to-end.

## Acceptance

- [ ] Per ticket 03's decision: migration implemented (with rollback + tests) OR closed as no-op with the leave-behavior pinned by a test.
- [ ] Full hermes suite green; the project-memory split works end-to-end (write `project` → `.planning/memory/` → `memory_search` merges project-local + global).
