# 05 — Promotion path: candidate → writing-skills TDD

---
type: grilling
blocked by: 02   # need the staging location to define the flow out of it
status: open
---

## Question

A candidate sits in `.planning/knowledge/`. How does it become a real skill via superpowers' `writing-skills` TDD process (RED: pressure-test the scenario → GREEN: author SKILL.md → REFACTOR)? Three coupled sub-decisions:

1. **Mechanism** — a command (`/promote-skill <candidate-id>`)? a new step/section in the `writing-skills` skill ("when starting RED, check `.planning/knowledge/` for a seeded candidate")? a wayfinder/plan trigger?
2. **Who fires it** — the user (deliberate) or the agent (recognizes a ready candidate)?
3. **Lifecycle** — on promotion, is the candidate consumed (moved/deleted) or kept as provenance?

## What to build

A grilled decision on the promotion mechanism + trigger + lifecycle. Candidate mechanisms to grill:

- **writing-skills integration** (recommended lean): add a "candidate seed" step to writing-skills' RED phase — "before authoring, check `.planning/knowledge/` for a candidate matching the skill you're about to test; use its trigger/symptom as the pressure scenario." No new command; reuses the existing TDD flow; the candidate IS the RED seed.
- **dedicated `/promote-skill` command**: explicit, but duplicates writing-skills' entry point.
- **wayfinder/plan trigger**: a candidate becomes a wayfinder ticket or plan item; heavy for a single skill.

## Acceptance

- [ ] Promotion mechanism chosen (writing-skills integration / command / trigger), with rationale.
- [ ] Who fires it decided (user / agent / either).
- [ ] Candidate lifecycle on promotion decided (consumed / kept-as-provenance).
- [ ] The path respects writing-skills' Iron Law (no skill without a failing test) — the candidate feeds RED, it does not skip it.
