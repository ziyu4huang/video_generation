# Snapshot Row Single Source — workflow presentation reads one projection

> STATUS: spec approved 2026-08-15 (brainstorming complete, awaiting plan)

## Goal

Make the workflow package's presentation layer read a **single trusted projection** instead of five hand-rolled per-site derivations. Three mechanics (Wave 1): (a) one `persistedToSnapshot` adapter owned by `run-persistence.ts`, compile-time-exhaustive over `PersistedAgentState` keys so a new persisted field that forgets to map is a **compile error**, not a silently blank row; (b) one `agentCounts(agents)` helper replacing the per-site `agents.filter(a => a.status === …)` copies, with snapshot rollup counters derived once; (c) one delivery-text builder (`deliverText` / `deliverTextFromPersisted` merged over a common subset, persisted path riding the ticket-1 adapter) and a typed `runStatusGlyph()` replacing the two untyped `STATUS_ICON` string maps — a new `RunStatus` missing a glyph becomes a **type error**, not the silent `"?"` fallback. Then one time-boxed spike (Wave 2): determine whether `task-panel` / `workflow-ui` can hydrate agents → `RunView` → `renderRunRow` cheaply enough to retire `ActivityRow` from production (test-only), with an explicit user decision gate before any retirement work. `ActivityRow`/`RunView` full convergence is **deferred to that spike**, not migrated blind.

## Evidence base

- **Walker findings** — Wayfind `improve-codebase-architecture` friction walks (arch review:
  `.planning/done/2026-08-14-subagent-workflow-arch-review/architecture-review-2026-08-14.md`,
  candidates C1/C2/C4; scan base noted there at `b384c9ed`, re-verified at `origin/main 01e2d8e4`
  and line-checked again at `ec98b13e` post-#1362).
- **Prerequisite shipped**: PR #1362 (`ec98b13e`) — `persistedToSnapshot` already maps
  `tokens` + `startedAt`; this effort generalizes that hand-maintained map into an
  exhaustiveness-checked adapter (the #1362 bug class — new persisted field, unmapped, blank row —
  is exactly what ticket 1 makes structurally impossible).
- Inline `file:line` evidence is embedded per section in `spec.md`.

## Tickets

Initial cut (5) — may be re-cut at plan time; details in `tickets/`:

1. `tickets/01-exhaustive-persisted-to-snapshot.md` — Wave 1
2. `tickets/02-agentcounts-single-derivation.md` — Wave 1
3. `tickets/03-unified-delivery-text.md` — Wave 1
4. `tickets/04-typed-run-status-glyph.md` — Wave 1
5. `tickets/05-activityrow-retirement-spike.md` — Wave 2 (time-boxed, user decision gate)
