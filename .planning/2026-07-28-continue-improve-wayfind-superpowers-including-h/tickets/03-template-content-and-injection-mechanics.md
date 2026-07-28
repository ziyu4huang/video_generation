# 03 — Template content + injection mechanics

---
type: grilling
blocked by: 01, 02   # need the capture moment + the candidate format before writing the template
claimed: wayfinder-session
status: closed
---

## Question

What exactly does the always-on prompt-injected template say, and how is it injected? This is the heart of the bridge — the text that turns "the agent learns a lesson" into "the agent captures a skill candidate." Two parts:

1. **Content** — the recognition criteria (what makes a lesson skill-worthy: reusable + procedural + not-already-a-skill + not-noise), the capture format (pointing at ticket 02's candidate fields), and the trigger guidance (firing at ticket 01's chosen moment).
2. **Injection mechanics** — extend hermes' existing memory-policy block (`prompt-context.ts` → `MEMORY_POLICY_PROMPT`), or a new dedicated block? Token budget (policy-only mode is deliberately lean — the template must be cheap)?

## What to build

A grilled decision + a drafted template (prose + the capture-format stub). Candidate injection points to grill:

- **Extend the memory-policy block** (`MEMORY_POLICY_PROMPT` / `_COMPACT`): co-located with the existing "when to search" guidance; one block; but grows the always-injected cost.
- **New dedicated block** in `prompt-context.ts`: separable, can be toggled; but adds a second always-on block.
- **A trigger-on-description skill** (lighter, on-demand): NOT always-injected, but depends on SDO firing at the right moment (ticket 01's moment).

## Acceptance

- [x] Injection point chosen (extend policy / new block / skill), with token-cost rationale.
- [x] Recognition criteria named (the skill-worthy predicate).
- [x] Template text drafted (prose + capture-format stub), pointing at ticket 02's fields + ticket 01's moment.
- [x] The decision respects superpowers' writing-skills SDO discipline (the template must not itself read like a skill the agent follows *instead of* writing-skills).

## Resolution

**Injection point: extend the memory-policy block's "Procedural skills" subsection** (`MEMORY_POLICY_PROMPT` full + `_COMPACT`, in hermes `src/constants.ts`). Fact-confirmed: the block (3691 chars full / 1693 compact, always-on in policy-only mode) ALREADY has a "Procedural skills" subsection routing reusable workflows to `skill_manage` — the candidate-capture guidance is a direct refinement of it. One injection point, no second always-on block; the ~180-token addition rides the block already injected every turn. (Rejected: a new dedicated `<skill-candidate-policy>` block — duplicates thematic territory the memory block owns + adds injection machinery.)

**Recognition criteria (skill-worthy bar):** reusable (across sessions/projects) + **procedural — a HOW, not a fact/WHAT** + not already covered by an existing skill + non-trivial. The fact-vs-procedure discriminator is the heart (matches the ubiquitous language: memory = facts/lessons, skills = procedures) — a failure memory "X broke because Y" stays in memory; the *procedure it implies* ("always do Z before Y") is candidate-worthy.

**Capture trigger** (from ticket 01): on the agent's own memory write meeting the bar, OR when `memory_search` surfaces the same procedure ≥2× (recurrence ⇒ reusability).

**Capture format** (from ticket 02): write `.planning/knowledge/<name>.md` with fields `trigger/symptom` · `lesson` · `proposed procedure` · `evidence` (the L1 memory id) · `candidate skill-name`. Do NOT create the skill yet.

**Reconciliation with the existing `skill_manage` route:** the candidate path does NOT replace `skill_manage` — it is the route for **lesson-derived procedures that warrant test-first validation**. `skill_manage` direct stays for deliberate, quick procedural capture that doesn't warrant TDD. Promotion (candidate → real skill) is a SEPARATE step via writing-skills' test-first process (pressure-test → author → verify), never bypassed.

**Drafted template text (full variant — appended to the "Procedural skills" subsection):**

> Skill candidates (lesson-derived):
> - When you save a memory (failure/correction/insight) that is a reusable PROCEDURE — a HOW, not a fact — and non-trivial, capture it as a skill CANDIDATE first, not a finished skill. A candidate is a seed for writing-skills' test-first process.
> - Capture trigger: on your own memory write meeting this bar, OR when `memory_search` surfaces the same procedure ≥2×.
> - Skill-worthy bar: reusable + procedural (HOW, not WHAT) + not already an existing skill + non-trivial. Facts stay in memory; only procedures become candidates.
> - To capture: write `.planning/knowledge/<name>.md` — fields: trigger/symptom · lesson · proposed procedure · evidence (memory id) · candidate skill-name. Do not create the skill yet.
> - Promotion is separate: a candidate becomes a real skill via writing-skills' test-first process, never bypassed. `skill_manage` direct stays for deliberate quick procedural capture.

**Compact variant** (~60 words, for `_COMPACT`): *Skill candidates: when a saved memory is a reusable, non-trivial PROCEDURE (a HOW, not a fact), capture it as a candidate in `.planning/knowledge/<name>.md` (fields: trigger, lesson, proposed procedure, evidence=memory id, skill-name) — a seed for writing-skills' test-first process, not a finished skill. Capture on your own such write, or when memory_search surfaces the same procedure ≥2×. `skill_manage` direct stays for deliberate quick procedures.*

**SDO respect:** the template is guidance pointing AT the candidate + promotion; it does not itself read as a workflow the agent follows instead of writing-skills (per the writing-skills SDO lesson — description = when-to-use, not a workflow summary).

**Open follow-up (noted, not blocking T03):** the template text references `.planning/knowledge/` (a path convention) + `writing-skills` (a superpowers skill name) from hermes' prompt. If we want to guard those cross-ext text references (like the routing-contract guard from the prior effort), that is a separate seam-hygiene task — not part of this ticket.

*(Resolves ticket 03; graduates the "exact template wording" fog; unblocks ticket 04 — frontier becomes {04, 05}. Plan-don't-do: implementation (editing constants.ts) is post-map.)*
