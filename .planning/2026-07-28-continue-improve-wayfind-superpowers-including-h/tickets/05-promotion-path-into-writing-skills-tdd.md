# 05 — Promotion path: candidate → writing-skills TDD

---
type: grilling
blocked by: 02   # need the staging location to define the flow out of it
claimed: wayfinder-session
status: closed
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

- [x] Promotion mechanism chosen (writing-skills integration / command / trigger), with rationale.
- [x] Who fires it decided (user / agent / either).
- [x] Candidate lifecycle on promotion decided (consumed / kept-as-provenance).
- [x] The path respects writing-skills' Iron Law (no skill without a failing test) — the candidate feeds RED, it does not skip it.

## Resolution

**Mechanism: writing-skills integration.** Add a "candidate seed" step to writing-skills' RED phase. The candidate's `trigger/symptom` field maps directly onto RED's pressure-scenario ("write a failing test that demonstrates the gap the skill addresses"), so the candidate IS the RED seed — it feeds the failing-test-first step, never skips it. No new command/surface; reuses the canonical skill-authoring skill. (Rejected: dedicated `/promote-skill` command — duplicates writing-skills' entry point + new surface to maintain; wayfinder/plan trigger — heavy for a single skill, couples promotion to the planning layer.)

**Drafted step (added to writing-skills' RED phase):**

> Candidate seed: before authoring, check `.planning/knowledge/` for a candidate matching the skill you're about to test. If one exists, use its `trigger/symptom` as the pressure scenario for RED — it is the real-world gap the skill must address. The candidate FEEDS the failing test; it does not skip it. On GREEN, author the SKILL.md carrying the candidate's `evidence` (memory id) as a provenance line. On completion, delete the candidate file (promoted) — or, if RED shows the candidate is not skill-worthy / already-covered, delete the candidate and ensure the lesson + its evaluated-not-skill status persists as a memory.

**Who fires: either (transparent).** The agent does the actual authoring (it runs writing-skills). Common path = agent-proactive-transparent: the agent recognizes a ready candidate, starts RED→GREEN→REFACTOR, keeps the user informed (never silent). User-deliberate ("promote candidate X") is equally valid. Promotion is always transparent — the user sees it happen and can veto. (Rejected: user-gated — adds friction to every promotion in a harness where the agent does most authoring; agent-proactive-silent — risks unwanted skills landing without a nod.)

**Lifecycle: consumed (removed) — candidate is transient, removed on EITHER outcome.**
- **Promoted**: candidate content → SKILL.md (canonical) + a provenance line carrying the source memory id; candidate file deleted.
- **Rejected** (RED shows not-skill-worthy / already-covered): candidate file deleted, but the lesson + its evaluated-not-skill status stays as a MEMORY (durable) — so re-capture is guarded by RED (promoted case) and by memory_search surfacing the not-skill status (rejected case).

Staging (`.planning/knowledge/`) stays a clean transient space — not a growing store (matches T02). (Rejected: kept-as-provenance — staging grows unboundedly, contradicts T02's "not a curated store"; consumed-archived — adds a `.promoted/` convention for marginal gain when the memory id already carries provenance into the skill.)

**Iron Law respected**: the candidate feeds RED (its trigger/symptom becomes the pressure scenario for the failing test); it never skips the test-first step.

**Feedback loop (fog, graduated):** the rejection→memory path is the calibration signal — a rejected lesson persists as a memory with its not-skill status, surfaced by future memory_search recurrence, calibrating the agent's skill-worthy judgment over time. No separate mechanism needed; calibration is an emergent property of this lifecycle.

*(Resolves ticket 05 — the last ticket. All 5 closed; all fog graduated; destination reached. Plan-don't-do: implementation (editing writing-skills/SKILL.md + MEMORY_POLICY_PROMPT) is the post-map phase.)*
