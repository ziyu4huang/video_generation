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

## Lifecycle

Candidates here are **transient** — this is staging, not a curated store.

- **Promoted**: the candidate's content is authored into a real `SKILL.md`
  (carrying its `evidence` memory id as provenance), and the candidate file is
  deleted from here.
- **Rejected** (writing-skills' RED shows it is not skill-worthy / already
  covered): the candidate file is deleted, but the lesson + its evaluated
  not-skill status stays as a **memory** (that persistence is the bridge's
  calibration signal).

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
