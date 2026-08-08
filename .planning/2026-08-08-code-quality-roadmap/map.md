---
effort: 2026-08-08-code-quality-roadmap
created: 2026-08-08
last: 2026-08-08
status: active
---

# Wayfinder map: 2026-08-08-code-quality-roadmap

## Destination

Ship the code-quality skill deliverables B–D as globally-auto-invocable skills, each placed in the right package and built via a Superpowers spec→plan→SDD cycle (like A). E (context-management/handover) is parked for a later cycle.

- **B** — code-review guidelines
- **C** — improve-codebase-architecture
- **D** — resolving-merge-conflicts

## Notes

**Domain:** `pi-agent-ext-*` skill packages. Two skill-bearing packages:
- `pi-agent-ext-superpowers` — byte-identical port of `obra/superpowers` (ADR-0004/0005/0006). LOCKED: no local skill edits, no new skills.
- `pi-agent-ext-wayfind` — pi-native, freely adaptable (7 skills, no cap).

**Connection mechanism:** skills are globally auto-invocable across packages via their `description:` (how codebase-design connects without editing superpowers bodies).

**Standing preferences:** one deliverable at a time, shipped deep before moving on; TDD/SDD; reply zh-TW, artifacts English.

**Skills to consult:** wayfind grilling/to-spec; superpowers writing-plans/executing-plans.

## Decisions so far

- [A: codebase-design SHIPPED to wayfind](../plans/2026-08-07-codebase-design-skill.md) — re-homed from superpowers (blocked by ADR-0004); merged PR #1080. Established the template: standalone skill in wayfind, description-based auto-invocability.
- [Superpowers off-limits for this track](../specs/2026-08-07-codebase-design-skill-design.md) — ADR-0004/0005 forbid local skill edits; only `using-superpowers/references/*` + `src/superpowers.ts` may deviate.
- [E parked] — context-management/handover sequenced after A–D.
- [ask-user TUI language hardening shipped] — unrelated detour, PR #1086 (askUserLanguage setting).

## Not yet specified

- Exact content/sourcing for B/C/D: Matt-Pocock-derived (e.g. his `requesting-code-review` / `code-reviewer.md`) vs pi-original vs hybrid.
- B's auto-invocability mechanism: description-based (like codebase-design) vs invocation-only (like grill-me-with-docs).
- Whether C/D warrant a new dedicated `pi-agent-ext-design` package (cleaner separation) vs consolidating into wayfind.

## Out of scope

- Editing superpowers skill bodies or adding non-upstream skills (ADR-0004).
- The ask-user TUI feature (shipped, PR #1086).
- E's content (parked).
