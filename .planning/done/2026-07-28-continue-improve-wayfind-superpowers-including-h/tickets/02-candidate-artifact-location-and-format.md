# 02 — Candidate artifact: location + format

---
type: grilling
blocked by:   # root ticket
claimed: wayfinder-session
status: closed
---

## Question

Where do skill candidates live, and what is their format? The candidate is an untested *seed* (feeds writing-skills' RED phase), not a shipped skill — so it must NOT pollute the converged L2 graph, the curated L1 memory, or the ext `skills/` dirs until promoted.

## What to build

A grilled decision on (a) staging location, (b) scope (project vs global), (c) the candidate's fields. Candidate locations: a repo-local dir (`.planning/knowledge/`), a global store (`~/.pi/agent/skill-candidates/`), a knowledge-card subtype tagged in the L2 graph, or in-place drafts next to future skills.

## Acceptance

- [x] Staging location + scope chosen, with rationale.
- [x] Candidate fields named (trigger/symptom, lesson, proposed procedure, evidence, candidate skill-name).
- [x] Decision respects: no pollution of curated stores; promotion target's location is named.

## Resolution

**`.planning/knowledge/` (project-scoped)** candidate staging. Chosen over a global store because this repo ships skills **in-repo** (ext `skills/` dirs, committed, PR-reviewed), so a repo-local staging makes the candidate→skill promotion symmetric and PR-reviewable. The user proposed this location during charting; evaluation confirmed it beats the global-store default. Three refinements baked in:

1. **Default project-scoped** — candidates promote to the relevant ext's `skills/` dir (symmetric); global/personal candidates are an explicit escape (→ `~/.pi/agent/`).
2. **Harvest guard** — `.planning/knowledge/` is a *persistent resident*, not an effort; the wayfinder closing ceremony must NEVER treat it as an effort dir to harvest/sweep. (The ceremony operates on `.planning/<effort>/`, a sibling, so no collision today — but the guard must be explicit.)
3. **Not redundant with the L2 graph** — graph = converged curated knowledge (deterministic sink); `.planning/knowledge/` = untested candidate drafts. Different layers; skill-worthy graph-cards can be *copied in* as candidates (upstream → staging), they don't conflict.

**Candidate fields** (to be sharpened in ticket 03's template): `trigger/symptom` · `lesson` · `proposed procedure` · `evidence` (memory id / graph card id / session ref) · `candidate skill-name`.

*(Resolved during charting by user decision — see map "Decisions so far".)*
