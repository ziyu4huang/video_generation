> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-21-brainstorm-code-review-bun-apps-pi-agent-ext-way

## Destination

A coherent, truthful story of how pi-agent-ext-wayfind and pi-agent-ext-superpowers actually co-work TODAY. Three concrete fixes close the gap between described-design and built-reality: (a) make wayfind's OWN docs stop describing the designed-not-built plan coordinator as a live runtime; (b) correct the study-news SOP note's COORDINATION framing to match; (c) centralize the `__piPlanPhases` constant. The plan coordinator itself is NOT built here — that decision already lives in the sibling effort `2026-07-19-build-plan-coordinator`; this map only cross-references it.

## Notes

- **Domain** — cross-extension coordination between wayfind (Layer-3: skills + slash commands + the `globalThis.__piWayfindActive` publisher) and superpowers (Layer-3: **pure skills, zero coordination code** — `index.ts:7` says so). The two co-work via ONE artifact on disk — `task_plan.md` (wayfind `seedPlan` writes it; superpowers `writing-plans` / `executing-plans` / `subagent-driven-development` read it). **No live coordination seam runs between these two extensions.** The seam the old note describes (yield + phase feedback) is wayfind ⇄ the plan coordinator.
- **The plan coordinator is designed, not built** (ADR-0003, 2026-07-19, Accepted). Every `__piPlan*` reader is a graceful no-op at runtime: no production code publishes `__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary` (grep-verified; only tests mock them). So `/wayfind sync` closes nothing and `goal_complete`'s `planningGateBlocking()` never gates.
- **The working loop today is MANUAL at the skill layer** (ADR-0003 decision, realized as PR #678 / effort `2026-07-19-goal-todo-handoff-stopgap`): the agent prompts the user to `/goal`, seeds `todo`s, calls `goal_complete`. `to-tickets/SKILL.md` documents this honestly ("### Set the session objective"); `wayfinder/SKILL.md` step 3 does NOT (still aspirational). The study-news note copied the aspirational story.
- **Consumer audit (done)** — `__piPlanIncomplete` is read only by goal-todo `goal.ts` (`planningGateBlocking`); `__piPlanPhases` is read only by wayfind `chain.ts` (`syncChainState`). No other consumers. hermes-memory reads `__piWayfindGrill` (grill-specific seam), not the plan coordinator.
- **Cross-effort landscape (decisions live in ONE place — do not duplicate):**
  - `2026-07-19-build-plan-coordinator` — **OPEN**, owns the "build the coordinator?" decision (ticket `01-build-plan-coordinator`, deferred) + its fog (where it lives, phase-driving, completion detection). → That is why THIS map has NO build ticket.
  - `2026-07-19-brainstorm-how-to-improve-wayfind-extension-fina` — **DONE** (2026-07-19). Fixed the note's ARTIFACT PATHS (three-tier classification, single-home spec, per-tracer-bullet plans; 8 edits, zero stale path refs). It did NOT touch the coordinator-as-runtime framing → that open axis is THIS map's [02] + [01]. **Do not re-litigate paths** — already synced.
  - `2026-07-19-goal-todo-handoff-stopgap` — the manual protocol (PR #678); the graceful fallback the coordinator-build effort would automate around.
- **This effort carries cheap doc/code fixes to completion, not just decisions** (override of wayfinder's default "plan, don't do"), per the destination chosen.
- **Frontier shape** — [02] and [03] are frontier (no blockers); [01] is `blocking: 02` (close the re-drift loop: the note derives from wayfind's docs, so correct the source first). Recommended order: [02] → [01], [03] anytime.
- **Skills every session should consult** — `wayfinder`, `grilling`, `domain-modeling`, `writing-skills` (doc-truth tickets edit skill files), `verification-before-completion`.

## Decisions so far

- [02 — Make wayfind's own docs honest about the plan coordinator](tickets/02-wayfind-docs-honest-about-coordinator.md) — plan coordinator marked designed-not-built (ADR-0003) across wayfinder/SKILL.md + README + CONTEXT; manual protocol now the documented working path; 143 tests + build green.
- [01 — Truthful co-work SOP note (coordination framing only)](tickets/01-truthful-co-work-note.md) — study-news note's coordination framing corrected to ADR-0003 reality (coordinator designed-not-built, manual protocol working, superpowers has no live seam); 9 edits, artifact paths untouched.
- [03 — Centralize the __piPlanPhases seam constant](tickets/03-centralize-piplanphases-constant.md) — PLAN_PHASES_KEY centralized in constants.ts; chain.ts reads via the constant (3 doc comments reworded); contract test added (RED→GREEN); 148 tests + build green.

## Not yet specified

- Promote the manual `/goal` + `todo` + `goal_complete` protocol to a canonical skill (ADR-0003 floats `driving-goal-and-todos`)? **Co-owned with the `2026-07-19-build-plan-coordinator` effort** — graduates into a ticket there if the build is deferred permanently; dissolves if the build happens. Not ticketed here (the decision it depends on lives there).
- Is the manual protocol empirically reliable end-to-end (does the agent actually follow "prompt `/goal` → seed `todo` → `goal_complete`" from the skill text, or drift)? Empirical; likely a prototype ticket after [02] + [01] land.

## Out of scope

- **Building the plan coordinator.** Lives in the sibling effort `2026-07-19-build-plan-coordinator` (ticket `01-build-plan-coordinator`, open/deferred). This map only cross-references it; re-litigating or duplicating that decision here violates "a decision lives in exactly one place".
- **Re-syncing the note's artifact paths.** Already done 2026-07-19 by `2026-07-19-brainstorm-how-to-improve-wayfind-extension-fina` (ticket `04-sync-docs-to-reality`). [01] touches only the coordination-seam framing.
- **Changing the seam contract** (the four `globalThis` keys + `task_plan.md` format tokens) — pinned by `plan-seed-contract.test.ts`, consumed by three packages.

## Postscript (2026-07-21) — premise invalidated by main; effort re-scoped

This map was charted on a working branch 32 commits behind `origin/main`. The core finding — "plan coordinator designed, not built" — was TRUE at that base but **FALSE on current main**: the coordinator was BUILT as `pi-agent-ext-core-task` (publishes all three `__piPlan*` seams; commit `501e59f5` e2e). Consequences:

- **[02] and [01] are MOOT / incorrect against main** — they mark a built coordinator as "designed-not-built" and would invert main's `phase`→`Task` rename. Their resolutions stand only as a record of work done against the stale base; do NOT re-apply them.
- **[03] (centralize `PLAN_PHASES_KEY`) survived** — re-applied on the main base (still a magic string there); committed on branch `docs/wayfind-coordinator-built-truth`.
- **The real doc-truth task on main is the INVERSE**: ADR-0003 still said "designed, not built" but the coordinator is built → ADR-0003 was itself stale, flipped to **Superseded** in the same branch.

**Lesson**: before charting a code-vs-docs map, sync the working branch to main — the premise can invert under active development.
