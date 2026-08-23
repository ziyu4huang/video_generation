# writing-skills candidate-seed step (Task B)

**Status:** shipped (README strengthening). No writing-skills edit — RED-proven redundant.
**Date:** 2026-07-29
**Provenance:** wayfinder effort `.planning/2026-07-28-continue-improve-wayfind-superpowers-including-h/` ticket 05 (closed).
**Scope:** one file — `.planning/knowledge/README.md` (lifecycle section made actionable).

## Problem

The learning→skill bridge's capture half (PR #921, in `MEMORY_POLICY_PROMPT`) tells the
agent to write skill candidates to `.planning/knowledge/<name>.md`. The promotion half was
the open thread (Task B): nothing wired candidates into `writing-skills`' authoring process.

## Original design (pre-RED)

Add a ~20-line "candidate seed" subsection to `writing-skills`' RED phase: check
`.planning/knowledge/` for a matching candidate; use its `trigger/symptom` as the RED pressure
scenario; on promotion carry `evidence` as provenance + delete the candidate; on rejection
delete + persist a not-skill verdict memory. (Concretizes ticket 05.)

## RED findings → pivot

The writing-skills Iron Law was applied to the would-be edit. Two isolated-context subagent
probes (current writing-skills injected, NO candidate-seed step, nothing in the task hinting
at `.planning/knowledge/`):

1. **Discovery probe (RED phase):** the agent **autonomously found + used** the fixture
   candidate — via `.planning/knowledge/README.md` (PR #921 documents the bridge) + filename
   match (`candidate skill-name` == the skill being authored) + exploration. **Discovery is
   not a gap.**
2. **Lifecycle probe (through completion):** with only the (then-conceptual) README on disk,
   the agent **correctly executed the full promotion lifecycle** — carried the `evidence`
   memory id as a provenance line AND planned to delete the candidate ("promotion consumes it;
   the directory must never grow"). **The lifecycle was already executable from the README.**

Per writing-skills' micro-test rule ("if the no-guidance control doesn't exhibit the failure,
stop — don't author the guidance"), **both the discovery guidance and a writing-skills
cross-reference are redundant.** Authoring them would violate the Iron Law.

## The one real improvement: make the README lifecycle actionable

The conceptual README lifecycle ("content is authored... carrying evidence... deleted") was
under-specified as an executable procedure. Strengthened it to explicit, ordered steps:

- **On promotion:** (1) carry `evidence` into the SKILL.md as a one-line provenance note;
  (2) delete the candidate file.
- **On rejection:** (1) delete the candidate file; (2) record the not-skill verdict as a memory
  (referencing the source memory id) so re-capture is guarded.

This is the entire shipped change. RED verified it suffices (the agent executed promotion
correctly from it alone).

## Decisions resolved (final)

- **No writing-skills edit.** RED proved the candidate-seed subsection + any cross-reference
  are redundant (agents discover candidates via the README + execute the lifecycle from it).
  Iron Law: don't author guidance the control doesn't need.
- **README is the promotion contract.** The staging-area README (read by agents that encounter
  candidates) carries the actionable lifecycle. No second copy in writing-skills.
- **Lifecycle: consumed (deleted) on either outcome** — promoted (content → SKILL.md +
  provenance) or rejected (deleted; verdict → memory). Staging stays transient.
- **Matching predicate:** `candidate skill-name` ≈ intended skill name (primary); trigger/symptom
  relevance (secondary). Effective without an explicit rule (filename match + README).

## Non-goals (unchanged)

- No new command/surface; no wayfinder/plan trigger; no capture-time dedup gate.

## Why not a separate plan doc

Single-file doc edit, evidence-driven via the Iron Law (RED probes). No writing-plans doc needed.

## Success criteria (met)

- A subagent given a present candidate uses it as the RED seed, carries provenance, and consumes
  it — **verified** (lifecycle probe), without any writing-skills change.
- Without a candidate, behavior is unchanged (normal RED) — N/A (no writing-skills edit).
- No regression: writing-skills untouched; README lifecycle section strengthened in place.

## Untested

- The **rejection** lifecycle path (delete + verdict-memory) was not probed directly; it is
  documented actionably and mirrors the RED-verified promotion path. Low risk.
- Micro-test rep count was 2 probes (discovery + lifecycle), not the 5+ the micro-test rule
  suggests; stakes are low (a lingering candidate or omitted provenance is minor) and both
  probes passed cleanly.
