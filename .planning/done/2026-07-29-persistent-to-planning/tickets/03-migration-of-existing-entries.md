# 03 — Migration of existing project-tagged entries

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

Existing `project`-tagged entries live in the GLOBAL store (`~/.pi/agent/pi-hermes-memory/MEMORY.md`). After the split, do we MIGRATE them (move to `.planning/memory/`) or LEAVE them (search still finds them globally via ticket 02's merge)?

## What to build

A grilled decision. Candidates:

- **Leave** (likely recommended): no migration; existing entries stay global, still surface via the search merge (ticket 02). New project writes go to `.planning/`. Zero data-movement risk; the cost is split provenance (old project memory global, new in-repo).
- **Migrate one-time**: move existing project-tagged entries to `.planning/memory/MEMORY.md` on first run. Cleaner (all project memory in-repo), but a data migration with rollback risk + the global store loses those entries.
- **Migrate on-demand**: a command (`/memory-migrate-project`) the user runs per repo when ready. User-controlled, no surprise migration.

## Acceptance

- [x] Migration decision (leave / migrate-one-time / migrate-on-demand), with rationale (data-movement risk vs in-repo completeness vs user control).
- [x] If migrate: names the mechanism + rollback + idempotency. If leave: confirms search still surfaces them (depends on ticket 02's merge).

## Resolution

**Decision: leave (no migration)** — existing project-tagged entries stay in the shared global store; search (ticket 02's single-DB-tag merge) surfaces them alongside project-local. New project writes → `.planning/`. Zero data-movement risk — nothing can break.

**Rationale**: the global store is SHARED across all projects (entries tagged by project name), so any migration must be per-project scoped (an auto-"migrate all project-tagged" would move OTHER repos' entries — wrong). Migration buys only physical relocation (git-trackability of old entries), at the cost of data-movement risk + per-project filtering + rollback. The search merge (ticket 02) keeps old entries fully functional, so migration's benefit is marginal. Rejected: **on-demand command** (ergonomic, but adds a command + move logic for marginal benefit — manual consolidation is trivial §-delimited cut/paste if ever wanted); **one-time auto** (surprise + automatic data movement on the shared store — riskiest).

**Leave confirmation (acceptance 2)**: `memory_search(project=X)` returns all entries tagged X — global-project-tagged (old) + project-local (`.planning/`) — merged in the single DB. Old entries stay functional, just not git-tracked. The split heals over time as new project entries land in-repo.

**Implication for ticket 05**: 05 becomes a **no-op migration + a regression test** — pin that old-global-project entries still surface via the search merge (guards against a future change that accidentally drops the global source from the index). No move logic to build.

*(Resolves ticket 03 — the last grilling decision. Frontier becomes {04}; 05 still blocked by 04.)*
