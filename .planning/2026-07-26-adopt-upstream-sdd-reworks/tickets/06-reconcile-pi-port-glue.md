## Question

Reconcile the pi-port glue with the new plan-scoped SDD interface: update `piBoundaryOverrides()` (routing rule 1), `sdd-workspace`, and `start-server.sh` so upstream's `.superpowers/sdd/<plan-slug>/` (now in the pinned SKILL.md) maps to the effort×plan layout decided in ticket 03.

**type:** task (AFK)
**claimed:** agent-session (2026-07-26) — **CLOSED**
**blocked by:** 03 (resolved: Nest), 05 (resolved: re-pin) — both done

## Acceptance

- Routing rule 1 + `sdd-workspace` resolve upstream's `<plan-slug>` workspace under the chosen effort×plan layout (likely `.planning/<effort>/sdd/<plan-slug>/`).
- `bootstrap.test.ts` updated to assert the reconciled paths (the routing-rule test I just wrote in commit `41e1ffb1` will need its path expectations updated for the plan-slug dimension).
- No `.superpowers/` dir created when an effort is active (preserve the convergence invariant).
- `sdd-workspace` accepts the plan file (upstream's `sdd-workspace PLAN_FILE` interface) and derives `<plan-slug>` while still honoring `PI_PLANNING_EFFORT`.

## Resolution (2026-07-26)

**DONE — commit `9671d84c`.** All acceptance criteria met + a necessary coupled fix:

- `scripts/sdd-workspace`: upstream's `PLAN_FILE` interface + plan-basename derivation, **patched** to honor `PI_PLANNING_EFFORT` → `.planning/<effort>/sdd/<plan-basename>/` (committed audit trail, no self-ignoring gitignore). Falls back to upstream's `.superpowers/sdd/<plan-basename>/` (self-ignoring) when no effort.
- `scripts/task-brief` + `scripts/review-package`: adopted upstream **verbatim** — both now take `PLAN_FILE` and pass `$plan` to `sdd-workspace`. (The fork had diverged: dropped `PLAN_FILE` from review-package, and called sdd-workspace with no arg — a pre-adoption regression.) The only real pi-divergence lives in sdd-workspace's resolution.
- Routing rule 1 (`piBoundaryOverrides`): SDD workspace → `.planning/<effort>/sdd/<plan-basename>/`; documents `sdd-workspace PLAN_FILE` resolves it.
- `bootstrap.test.ts`: assertions updated for the plan-basename dimension + `PLAN_FILE` (TDD: RED → GREEN).
- **start-server.sh: NO change** — brainstorm-only, no plan-slug dimension.
- Convergence invariant verified: effort branch → `.planning/` (no `.gitignore`); no `.superpowers/` dir created when effort active.
- End-to-end verified: task-brief + review-package chain through sdd-workspace to the effort+plan path.
- Full suite: **122 / 0**.

**status:** closed
