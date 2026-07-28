# 03 — Migration of existing project-tagged entries

---
type: grilling
status: open
---

## Question

Existing `project`-tagged entries live in the GLOBAL store (`~/.pi/agent/pi-hermes-memory/MEMORY.md`). After the split, do we MIGRATE them (move to `.planning/memory/`) or LEAVE them (search still finds them globally via ticket 02's merge)?

## What to build

A grilled decision. Candidates:

- **Leave** (likely recommended): no migration; existing entries stay global, still surface via the search merge (ticket 02). New project writes go to `.planning/`. Zero data-movement risk; the cost is split provenance (old project memory global, new in-repo).
- **Migrate one-time**: move existing project-tagged entries to `.planning/memory/MEMORY.md` on first run. Cleaner (all project memory in-repo), but a data migration with rollback risk + the global store loses those entries.
- **Migrate on-demand**: a command (`/memory-migrate-project`) the user runs per repo when ready. User-controlled, no surprise migration.

## Acceptance

- [ ] Migration decision (leave / migrate-one-time / migrate-on-demand), with rationale (data-movement risk vs in-repo completeness vs user control).
- [ ] If migrate: names the mechanism + rollback + idempotency. If leave: confirms search still surfaces them (depends on ticket 02's merge).
