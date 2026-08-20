**ID:** `ADR-s2-agent-core-runtime-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR 0001 — RunView: destructive convergence of the run read surface

## Status

Accepted (2026-08-14)

## Context

The elapsed-freeze bug family (PR #1313) exposed a structural problem: derived
presentation state (elapsed, frozen-vs-live, latest action, tool-call count,
model segment) was re-derived independently at every render site, and each site
had to remember the freeze rule (`endedAt - startedAt` once terminal) itself.
Any new surface (or any refactor of an old one) could silently reintroduce the
bug. Compounding this, the codebase carried two status vocabularies — the
in-flight registry's `"running" | "completed"` versus the display layer's
`ActivityStatus` — so terminal states like "failed" could not even be
represented in the registry.

## Decision

1. `InFlightSubagent` leaves the public surface once consumers migrate
   (Dispatch B). `RunView` — an immutable, per-tick projection built only by
   the registry — becomes the only public read; renderers never touch raw run
   fields.
2. A fat projection record (`RunView`) over a behavioral smart object or an
   opaque handle. Smart objects own eviction-sensitive lifetime (registry
   deletes entries mid-render → dangling methods), and a `snapshot()` escape
   hatch rots the surface it was meant to protect. An opaque handle forces
   getter creep the moment a viewer needs non-render logic (sort/filter/follow).
3. Per-tick rebuild via `registry.view(s)()` is accepted: one pass per render
   tick is cheaper than today's per-site scans. The never-cache contract is
   documented on `RunView` itself.
4. Status vocabulary unifies on `ActivityStatus`; `markCompleted` /
   `markFailed` stamp a `TerminalStatus` plus `endedAt`, making the freeze rule
   enforceable in one place (`buildRunView`).

## Considered alternatives

- Behavioral smart object per run — rejected: eviction lifetime bugs.
- Opaque handle + getters — rejected: getter creep for viewer-side logic.
- Keep raw record public, add helper functions — rejected: derivations stay
  duplicated across call sites; the PR #1313 family returns.

## Consequences

The registry gains `view()` / `views()` / `updateTaskPreview()`;
`get()` is marked `@internal` (Dispatch B removes) and `list()` is
`@deprecated`. Test fixtures migrate to the unified status vocabulary, and the
legacy `"completed"` literal is coerced to `"done"` at `start()` until external
callers migrate.
