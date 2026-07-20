# Map — unify the goal↔plan↔todo coordination (restore skill fidelity + one layer)

## Destination

A single coordination layer publishes the `__piPlan*` seams, parses BOTH plan conventions (superpowers' writing-plans output + wayfind's `task_plan.md`), and drives the shared `/goal` + `todo` singletons — **without editing the superpowers skills**, which are restored to byte-identical upstream. This replaces the #678 skill-edit stopgap (ADR-0003) and reconciles the two prior designs — `let-s-make-superpower-status-can-full-integrate-` and `build-plan-coordinator` — into one invariant-respecting effort.

## Notes

**Domain:** three Pi extensions — `pi-agent-ext-goal-todo` (owns `/goal`+`goal_complete`, `todo`, the composite widget, and the readers `planningGateBlocking` / `planProgressLineFromPeer`), `pi-agent-ext-superpowers` (methodology; skills byte-identical to upstream), `pi-agent-ext-wayfind` (owns `task_plan.md`, `chain.ts` `syncChainState`, `coordination.ts` readers).

**Two settled decisions (this effort's trunk — resolved in the charting grill):**

1. **Destination = restore skill fidelity** — refined in [01](tickets/01-revert-skill-edits-restore-fidelity.md) to **"byte-identical to upstream EXCEPT necessary pi-port glue"** (the literal "byte-identical" was always too strict; a pi-port necessarily diverges for tool/action mapping). Four commits edited superpowers skills since the #617 port: #664 / #676 / #678 (convention injections — reverted by 01) + #639 (subagent-dispatch glue — kept). `tests/skills.test.ts` enforces structure only, so the violations passed CI silently.
2. **Architecture = ONE unified coordination layer** (not two). It publishes `__piPlan*` (the names `goal.ts` + `coordination.ts` already read), parses both plan conventions, feeds the singleton goal/todo + widget. Merges the two prior efforts into one.

**Key facts (already verified — don't re-litigate):**

- The "plan coordinator" middle layer was **designed but never built** (ADR-0003): zero publishers of `__piPlan*`; `goal_complete`'s `planningGateBlocking()` always returns `undefined`; `/wayfind sync` is a no-op; widget slot order=3 unfilled.
- The older effort (`let-s-make-superpower-status-`) resolved 3 tickets (01 plan-convention; 02 cross-ext store via globalThis pub/sub — NOT direct import, jiti dual-instance hazard; 04 bidirectional sync mapping) but left 03/05/06 open, used **different seam names** (`__piSuperpowersPlan*` vs the readers' `__piPlan*`), and the now-**retired** `docs/superpowers/plans/` path.
- goal-todo's `/goal` + `todo` are **singletons** — one objective, one step list — so two competing publishers would double-drive.
- wayfind's own skills (`to-spec`, `to-tickets`) are **owned** (not upstream-ported); their edits stand. Only the 5 superpowers skills need reverting.

**Skills every session should consult:** `grilling`, `domain-modeling`, `wayfinder`; `writing-plans`, `executing-plans`, `subagent-driven-development`, `verification-before-completion` (as upstream references, NOT edit targets).

**Standing prefs:** PLAN-FIRST; HONESTY OVER FACE-SAVING; conversation zh-TW, artifacts English; preserve the graceful-seam design (globalThis singleton, no-op when peer absent).

## Decisions so far

- [01 — Revert skill edits; restore fidelity](tickets/01-revert-skill-edits-restore-fidelity.md) — reverted #664/#676/#678 convention injections → #617-port verbatim; kept #639 pi-port glue; invariant refined to "byte-identical except necessary pi-port glue"; conventions relocate to [02](tickets/02-unified-coordination-layer.md) / wayfind.
- [02 — Unified coordination layer](tickets/02-unified-coordination-layer.md) — lives **inside goal-todo** (no new package; publishes `__piPlan*` for wayfind); parses ONE canonical format = **writing-plans** (wayfind adjusts; Task≡phase preserves the `__piPlanPhases` reader model + `/wayfind sync` loop); older `__piSuperpowersPlan*` design superseded.
- [03 — Seam contract](tickets/03-seam-name-unification.md) — contract pinned by existing readers: goal-todo publishes `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` (one-way to wayfind); goal-todo self-consumes via **internal-call** (no self-read, goal.ts refactored to direct calls); older `__piSuperpowersPlan*`/`__piApplyTodoToggle` superseded; Task≡phase.
- [06 — Close & supersede prior efforts](tickets/06-close-and-supersede-prior-efforts.md) — bookkeeping executed: closed `let-s-make-superpower-` 03/05/06 (folded → 04/05 here) + `build-plan-coordinator/01`; both prior maps annotated `superseded-by: 2026-07-19-a`. `2026-07-19-a` is now the single live coordination-layer effort.
- [07 — Skill fidelity guard](tickets/07-skill-fidelity-guard.md) — RESOLVED (grilled 2026-07-20): positive content pin of all 14 upstream-ported SKILL.md (not denylist — dep-guard ADR-0001 lesson); re-sync = explicit `rebaseline-upstream-skills.ts` + `UPSTREAM.ref` provenance (no auto). Implemented + ADR-0004. Frontier now 05 only (04 resolved by research — timing/lifecycle/replay verified in the 09 build, yield N/A; 08 closed #724; 09 concrete-build complete #715–#719/#722).

## Not yet specified

<!-- fog — graduates as the frontier advances -->

- **Upstream re-sync mechanics.** If upstream superpowers has advanced since the port, "restore byte-identical" is a re-port from current upstream, not a pure `git revert`. Graduates into a research sub-ticket when [01](tickets/01-revert-skill-edits-restore-fidelity.md) is worked.
<!-- plan-format convergence RESOLVED by [02](tickets/02-unified-coordination-layer.md): writing-plans canonical, wayfind adjusts, Task≡phase. Graduated to [08](tickets/08-wayfind-migrates-to-writing-plans-format.md). -->
- **[04](tickets/04-sync-timing-and-lifecycle.md) RESOLVED** (research, 2026-07-20): timing/lifecycle/replay/idempotency all implemented + verified in the [09](tickets/09-build-coordination-layer.md) build (session_start full sync; tool_execution_end gated to mutating tools; replay-before-seed; empty-only seed). yield (TB5b) = N/A — the plan coordinator has no auto-drive to yield (no injection/auto-continue; only passive publish + empty-only seed + user-initiated gate). Finding: `__piWayfindActive` is a dangling publish (harmless no-op; optional cleanup). **[05](tickets/05-multi-plan-representation.md) remains deferred** — single active-effort heuristic suffices.

## Out of scope

- **Forking the superpowers skills** (destination settled: restore the invariant, not retire it). Revisit only if upstream re-sync proves untenable.
- **Editing upstream superpowers skills** to drive goal/todo — the exact violation this effort undoes.
- **The `2026-07-17-wayfind-pwf-unification` effort** (shared widget + command consolidation) — different axis; may share the widget-slot outcome but is a separate effort.
