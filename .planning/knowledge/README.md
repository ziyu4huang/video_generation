# Skill candidates (learning→skill bridge)

This directory is the **staging area for skill candidates** — structured seeds
that a learned lesson (a saved memory) leaves behind when it looks **skill-worthy**,
pending promotion into a real L3 `SKILL.md` via superpowers' `writing-skills`
test-first process.

## What lives here

One file per candidate: `<name>.md`, with these fields:

- **trigger/symptom** — the observable situation that signals the procedure applies.
- **lesson** — the learned lesson (what failed / what worked and why).
- **proposed procedure** — the HOW the lesson implies (a method, not a fact).
- **evidence** — the source L1 memory id (the durable record this candidate derives from).
- **candidate skill-name** — the hyphenated name the eventual skill would take.

## Skill-worthy bar (from the injected memory-policy block)

A candidate is captured only when the lesson is: **reusable** (across
sessions/projects) + **procedural** (a HOW, not a fact) + **not already an
existing skill** + **non-trivial**. Facts stay in memory; only procedures
become candidates.

## Lifecycle (actionable — execute when a candidate seeds a skill)

Candidates here are **transient** — this is staging, not a curated store. When a
candidate seeds a skill you are authoring via writing-skills, finish the lifecycle
on completion:

**On promotion** (the skill is authored and its tests pass):
1. Carry the candidate's `evidence` (source memory id) into the new `SKILL.md`
   as a one-line provenance note (e.g. `> Provenance: mem:<id>`).
2. Delete the candidate file from this directory — the content now lives in the
   skill.

**On rejection** (writing-skills' RED shows the candidate is not skill-worthy, or
an equivalent skill already exists):
1. Delete the candidate file from this directory.
2. Record the verdict as a **memory** (target: `memory` or `failure`; category:
   `insight` or `correction`) — e.g. "evaluated not-skill-worthy: <reason>" —
   referencing the source memory id. This guards re-capture and is the bridge's
   calibration signal.

Either way the candidate is **consumed** (removed); this directory never grows.

Dedup is deferred to promotion — no capture-time gate. The important dedup
(candidate ≈ existing skill) is caught by writing-skills' RED phase; a
filesystem name-collision here is a free implicit signal for candidate-vs-candidate.

## Not an effort

This directory is **not** a wayfinder effort. It is never enumerated as one
(efforts are accessed by explicit name only). The wayfinder closing ceremony
(`/wayfind done`) must never harvest or sweep it.

## Design provenance

See the wayfinder effort
`.planning/2026-07-28-continue-improve-wayfind-superpowers-including-h/`
(tickets 01–05) for the full design decisions behind this bridge.
