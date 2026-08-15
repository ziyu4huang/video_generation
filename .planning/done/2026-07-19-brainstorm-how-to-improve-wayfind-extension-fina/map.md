> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — unify wayfind + superpowers planning artifacts under .planning/

## Destination

Every **effort-scoped** planning artifact — from both wayfind (decision tickets, map, spec, task_plan) and superpowers (implementation plans) — lives under one home: `.planning/<effort>/`. The perceived "scatter" is resolved by (a) retiring the one real divergence (`to-spec`'s `docs/specs/` alt), (b) switching superpowers' `writing-plans` from a singular `plan.md` to per-tracer-bullet `plans/<NN>-<slug>.md`, and (c) fixing the **doc drift** in the vault SOP doc (`agents-develop-sop-wayfind-superpowers.md`), which still describes the long-gone `docs/superpowers/plans/` path. The three frontier decisions land in the rewritten vault SOP doc, which then hands a precise change-list to superpowers to execute (skill-prose edits — no deep code). Cross-cutting domain artifacts (`CONTEXT.md` glossary, `docs/adr/`) stay at the domain root by design.

## Notes

**Domain:** two `@repo/` workspace packages — `pi-agent-ext-wayfind` (planning) and `pi-agent-ext-superpowers` (execution) — and the vault SOP doc that documents their handoff (`../study-news/content/agents-develop-sop-wayfind-superpowers.md`).

**Skills every session should consult:** `grilling`, `domain-modeling`, `to-spec`, `to-tickets`, `wayfinder` (wayfind); `writing-plans`, `subagent-driven-development`, `requesting-code-review` (superpowers).

**Three settled decisions (this effort's trunk — resolved in the charting grill):**

1. **Destination shape = decisions + docs, then hand off to superpowers.** Wayfinder is planning (produces decisions, not deliverables). This effort resolves the open artifact-location decisions, bakes them into the vault SOP doc, and hands the change-list to superpowers to execute. (Matches the user's PLAN-FIRST preference.)
2. **Scope = cross-extension.** superpowers' planning docs ARE in scope — they must align to wayfind's `.planning/<effort>/` home, not stay in a separate root. (The user's explicit ask.)
3. **`CONTEXT.md` + `docs/adr/` stay at the domain root.** They are cross-cutting domain artifacts (project-level ubiquitous language + architecture decisions), **not** effort-scoped. `chain.ts:202` hardcodes `join(cwd, "CONTEXT.md")` by design. They are documented as a deliberate exception tier, not moved.

**Key facts (already verified — don't re-litigate):**

- **The scatter is ~80% already fixed in code.** superpowers `writing-plans` and `brainstorming` ALREADY write under `.planning/<effort>/` (`plan.md`, `spec.md`). The vault SOP doc is **stale** — it still says `docs/superpowers/plans/<date>-<feature>.md`, a path that no longer exists in the skills.
- **superpowers path conventions live in skill PROSE** (`skills/*/SKILL.md`), not code — `src/` is a 2-file Pi wrapper. Changing a location = editing SKILL.md prose, not deep logic. `<effort>` is an agent-inferred placeholder (no programmatic discovery today).
- **The one real wayfind divergence** is `to-spec`'s dual write location (`.planning/<effort>/spec.md` *or* `docs/specs/<slug>.md`). → [Ticket 01](tickets/01-single-home-for-spec.md).
- **superpowers `writing-plans` writes a singular `plan.md`** per effort; two reader sites hardcode that path (`requesting-code-review:60`, `subagent-driven-development:277`). → [Ticket 02](tickets/02-per-tracer-bullet-plan-files.md) switches to plural `plans/*.md` and updates both readers.
- **`.superpowers/sdd/`** (progress ledger, review diffs, task briefs) is runtime scratch, not a planning document. → [Ticket 03](tickets/03-sdd-runtime-scratch-disposition.md).
- **Naming coexistence:** wayfind's `/wayfind seed` writes `task_plan.md` (the phase spine); superpowers' `writing-plans` writes `plan.md` / `plans/*.md` (implementation plans). Both under `.planning/<effort>/` — distinct artifacts; the vault doc must distinguish them sharply (today it does, but the paths are stale).

**Standing prefs:** PLAN-FIRST; HONESTY OVER FACE-SAVING; conversation zh-TW, artifacts English; one-question-at-a-time grilling.

## Decisions so far

- [01 — Single home for spec.md](tickets/01-single-home-for-spec.md) — retire the `docs/specs/` alt; `spec.md` single-homed at `.planning/<effort>/spec.md`; `to-spec` ≡ `brainstorming` (same artifact).
- [02 — Per-tracer-bullet plan files](tickets/02-per-tracer-bullet-plan-files.md) — `plan.md` (singular) → `plans/<NN>-<slug>.md` (one per ②, same-NN as its ticket); reader sites (`requesting-code-review`, `subagent-driven-development`) follow; effort-discovery = prose convention (from the handed-off `task_plan.md`).
- [03 — .superpowers/sdd/ runtime scratch](tickets/03-sdd-runtime-scratch-disposition.md) — leave at repo root (runtime scratch, **gitignored ✓**); documented as a distinct tier, not a planning artifact.
- [04 — Sync docs to reality](tickets/04-sync-docs-to-reality.md) — vault SOP doc rewritten (8 edits, **zero stale refs**): three-tier classification + single-home spec + per-tracer-bullet plans.

**Frontier EMPTY — destination reached.** Every decision the destination depends on is settled; what remains is *doing*, not deciding (the superpowers execution hand-off below).

## Not yet specified

<!-- in-scope fog you can't ticket yet; graduates as the frontier advances -->

- **Robust effort-discovery for superpowers.** *(✅ graduated + resolved by [02](tickets/02-per-tracer-bullet-plan-files.md))* — `writing-plans` resolves `<effort>` from the `task_plan.md` it was handed (prose convention). **No active-effort marker**; revisit only if a real SDD run proves the ambiguity bites.

---

## Hand-off to superpowers (the execution edge)

**✅ EXECUTED (2026-07-19).** All four skill-prose edits applied directly; both packages' `bun test` green (wayfind **143 pass / 0 fail**; superpowers **95 pass / 0 fail**). No test asserted on these paths, so zero test edits were needed.

| # | File | Edit |
|---|---|---|
| 1 | `pi-agent-ext-wayfind/skills/to-spec/SKILL.md` | delete the `（或 docs/specs/<slug>.md）` alt clause → single home `.planning/<effort>/spec.md` |
| 2 | `pi-agent-ext-superpowers/skills/writing-plans/SKILL.md` | `plan.md` → `plans/<NN>-<slug>.md` (lines 18, 160) |
| 3 | `pi-agent-ext-superpowers/skills/requesting-code-review/SKILL.md` | line 60 plan path → `plans/<NN>-<slug>.md` |
| 4 | `pi-agent-ext-superpowers/skills/subagent-driven-development/SKILL.md` | line 277 plan path → `plans/<NN>-<slug>.md` |

All four were **skill-prose edits** (superpowers paths live in SKILL.md, not `src/`); no deep code, **zero test edits** (no test asserted on these paths — confirmed by the green runs). The convention the vault SOP doc describes is now reality.

## Out of scope

<!-- ruled out — closed, never graduates -->

- **Moving `CONTEXT.md` + `docs/adr/` under `.planning/`.** Cross-cutting by design (project-level glossary + architecture decisions); `chain.ts:202` hardcodes them at cwd. Documented as a deliberate exception tier in the vault SOP doc instead. (Settled in the charting grill.)
- **Deep code changes to wayfind `src/` path logic.** None needed — all path conventions live in skill prose; the one `src` reference (`chain.ts:202` `CONTEXT.md` at cwd) is correct and unchanged.
- **The `2026-07-17-wayfind-pwf-unification` effort** (shared status widget + 19→3 command consolidation). Different axis (UI / command surface), not artifact location.
