# Wayfinder map: 2026-08-01-what-s-to-do-next

## Destination

Decide what to work on next, and take the first step.

## Notes

- **Router effort.** Charting surfaced that the way to the chosen destination was already clear via an existing map, so **no new tickets were created here** (wayfinder step 3 — no fog).
- **Branch freshness resolved at start:** rebased `wip/next` onto `origin/main` (0 behind), reconciled the planning-unification (#976) `docs/superpowers/plans` symlink collision, restored 2 hermes plan records to canonical `.planning/plans/`.
- **PR #980** (hermes graph-orphan heal + consolidator lock-retry + power-tool argsSig) **merged to main** (squash `8f4adea5`) during this session — effectively closes the `2026-08-01-hermes-legacy-id-graph-orphan` effort.

## Decisions so far

- **Next = finish the hermes stable-ID migration** (effort `2026-07-31-5d-stable-id-…`). No new map needed — that effort is mature; resumed it directly.
- [5d ticket 02 — dual-backend id reconciliation](../2026-07-31-5d-stable-id-md-status-frontmatter-5b-content-ke/tickets/02-dual-backend-id-reconciliation.md) — **RESOLVED 2026-08-01**: `md_id` is agnostic/portable (uuid v4 from ticket 00), a secondary unique-indexed TEXT column/field on both backends; existing PK + lineage refs unchanged and stay DB-only; nullability timeline defers to ticket 01. **New frontier: 5d ticket 01 (backfill & migration).**

## Not yet specified

<!-- none -->

## Out of scope

- **`wip/next` cleanup** — `wip/next` now carries 4 fix commits redundant with main's squash `8f4adea5` (plus a docs commit + a planning-restore chore) and sits behind main. Needs a rebase-drop before any *code* work lands on it. Follow-up hygiene, not part of the "what's next" routing.
