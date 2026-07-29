# writing-skills candidate-seed step (Task B)

**Status:** approved → implementation (RED→GREEN→REFACTOR)
**Date:** 2026-07-29
**Provenance:** wayfinder effort `.planning/2026-07-28-continue-improve-wayfind-superpowers-including-h/` ticket 05 (closed). This spec is the implementation-level concretization of that grilled decision.
**Scope:** single file — `skills/writing-skills/SKILL.md`.

## Problem

The learning→skill bridge's capture half (PR #921, in `MEMORY_POLICY_PROMPT`) tells the
agent to write skill candidates to `.planning/knowledge/<name>.md` when a saved memory
looks skill-worthy. Fields: `trigger/symptom`, `lesson`, `proposed procedure`,
`evidence` (source memory id), `candidate skill-name`.

The promotion half is missing: `writing-skills` has no step that checks the staging area,
so a candidate can sit there indefinitely with nothing wired to consume it. The bridge is
half-built — capture works, promotion doesn't.

## Design (concretizes ticket 05)

Add a **candidate-seed step** to `writing-skills`' RED phase — a precondition the authoring
agent checks before writing the pressure scenario. The candidate **feeds** the failing test
(its `trigger/symptom` becomes the pressure scenario); it never **skips** test-first.

### Placement

New subsection immediately before `### RED: Write Failing Test (Baseline)`, titled
`### Candidate Seed (RED precondition)`. It is a precondition for authoring the scenario,
so it precedes RED rather than folding into it (keeps the RED phase's own content unchanged).

### Step content (target wording — finalized during GREEN)

> Before writing the pressure scenario, check `.planning/knowledge/` for a candidate whose
> `candidate skill-name` matches the skill you are about to author (or whose `trigger/symptom`
> is the gap you are addressing).
>
> - **If a candidate exists:** use its `trigger/symptom` as the RED pressure scenario — it is
>   the real-world gap the skill must address. The candidate FEEDS the failing test; it does
>   not skip it. On GREEN, carry the candidate's `evidence` (the source memory id) into the
>   SKILL.md as a one-line provenance note. On completion, delete the candidate file
>   (promoted).
> - **If RED shows the candidate is not skill-worthy / already covered:** delete the candidate
>   AND record the not-skill verdict as a memory (referencing the source memory id) so
>   re-capture is guarded.
> - **If no candidate exists:** proceed with normal RED (author the pressure scenario yourself).

### Decisions resolved

- **Matching predicate:** primary = `candidate skill-name` ≈ intended skill name (the
  candidate declares what skill it wants to become); secondary = `trigger/symptom` relevance.
  The agent authors the skill either way (writing-skills was invoked); the candidate only
  seeds RED.
- **Rejection→memory mechanism:** write a short memory (target: memory or failure; category:
  insight/correction) recording the not-skill verdict + referencing the source memory id.
  Chosen over mutating the original memory because the memory tools have no clean
  "annotate existing" path and a dedicated verdict is queryable + guards re-capture.
- **Lifecycle:** consumed (deleted) on EITHER outcome — promoted (content → SKILL.md +
  provenance) or rejected (deleted; verdict → memory). Matches ticket 05 + `knowledge/README.md`.
  Staging stays transient, not a growing store.

### Non-goals (YAGNI)

- No new command or surface (rejected in ticket 05: a `/promote-skill` command duplicates
  writing-skills' entry point).
- No wayfinder/plan trigger (rejected: heavy for a single skill, couples promotion to planning).
- No capture-time dedup gate (deferred to promotion; ticket 04).

## Iron Law compliance (the edit is itself TDD)

Editing an existing skill triggers writing-skills' own Iron Law: RED → GREEN → REFACTOR with
pressure scenarios. The cycle:

- **RED** — dispatch a subagent with the **current** writing-skills (no candidate-seed step) +
  a seeded fixture candidate in `.planning/knowledge/` + a task to author that skill. Baseline:
  does it check/use the candidate? **Expected: no** — nothing tells it to look. Gap proven.
- **GREEN** — add the candidate-seed step. Re-run the same scenario. Verify the agent now
  finds the candidate, uses its `trigger/symptom` as RED, carries provenance, and consumes
  the candidate on outcome.
- **REFACTOR** — probe loopholes: authoring the skill without testing the candidate;
  promoting but not deleting the candidate; skipping the provenance line; rejecting without
  persisting the not-skill verdict. Add explicit counters; re-test until bulletproof.

## Why not a separate plan doc

Single-file, ~20-line edit with its own TDD method. A formal writing-plans doc + subagent-
driven-development is overkill; the design above + the Iron Law cycle is the implementation.

## Success criteria

- A subagent given writing-skills (post-edit) + a present candidate uses the candidate as the
  RED seed, carries provenance, and consumes the candidate — without skipping the failing test.
- Without a candidate, behavior is unchanged (normal RED).
- The edit survives REFACTOR loophole probes.
- No regression: writing-skills' existing structure/wording intact.
