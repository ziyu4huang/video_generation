## Question

Reconcile the pi-port glue with the new plan-scoped SDD interface: update `piBoundaryOverrides()` (routing rule 1), `sdd-workspace`, and `start-server.sh` so upstream's `.superpowers/sdd/<plan-slug>/` (now in the pinned SKILL.md) maps to the effort×plan layout decided in ticket 03.

**type:** task (AFK)
**claimed:** _(open)_
**blocked by:** 03 (path design gates the override), 05 (pin must land first)

## Acceptance

- Routing rule 1 + `sdd-workspace` resolve upstream's `<plan-slug>` workspace under the chosen effort×plan layout (likely `.planning/<effort>/sdd/<plan-slug>/`).
- `bootstrap.test.ts` updated to assert the reconciled paths (the routing-rule test I just wrote in commit `41e1ffb1` will need its path expectations updated for the plan-slug dimension).
- No `.superpowers/` dir created when an effort is active (preserve the convergence invariant).
- `sdd-workspace` accepts the plan file (upstream's `sdd-workspace PLAN_FILE` interface) and derives `<plan-slug>` while still honoring `PI_PLANNING_EFFORT`.
