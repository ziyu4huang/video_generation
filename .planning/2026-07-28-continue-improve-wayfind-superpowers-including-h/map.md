# Wayfinder map: 2026-07-28-continue-improve-wayfind-superpowers-including-h

## Destination

Build the **learning→skill export bridge**: a prompt-injected template (always-on, in hermes' prompt layer — like the memory-policy block) that makes the agent recognize when a learned lesson (a saved failure/correction/insight, or a recurring pattern surfaced by `memory_search`) is **skill-worthy**, and capture it as a **skill candidate** — a structured seed (trigger/symptom, lesson, proposed procedure, evidence). The candidate is then **promoted via superpowers' existing writing-skills TDD process** (pressure-test → author → verify) into a real L3 `SKILL.md`. The bridge spans **hermes** (template injection + learning source), **superpowers** (writing-skills as the promotion path), and a new **candidate artifact + staging** concern. "Improve wayfind + superpowers" is the context that seeded this, not a separate destination.

## Notes

- **Domain**: the 3-layer knowledge system — L1 hermes (working memory + background-review learning loop), L2 knowledge-card (Zettelkasten convergence via `zk_ingest`), L3 skills (`skill_manage` + superpowers' `writing-skills` TDD authoring).
- **Skills every session should consult**: `wayfinder` (work-the-map), `grilling` + `domain-modeling` (resolve tickets), `writing-skills` (the promotion target's discipline).
- **Key constraint**: superpowers' core discipline is "no skill without a failing test first." The bridge MUST NOT bypass this — export produces a *candidate* (seed), never a finished skill; promotion always goes through writing-skills' RED-GREEN-REFACTOR.
- **jiti constraint** (carried from the coexistence effort): cross-extension singletons live on `globalThis`; the template injection extends hermes' existing prompt layer — no new cross-extension runtime seam required.
- **Concurrency**: last-write-wins on `.planning/` (wayfind ADR-0005); `.planning/knowledge/` (the candidate staging, decided in ticket 02) is a persistent resident, NOT an effort — the wayfinder closing ceremony must never harvest/sweep it.

## Decisions so far

- [Candidate artifact: location + format](tickets/02-candidate-artifact-location-and-format.md) — **`.planning/knowledge/` (project-scoped)** candidate staging. Three refinements: (a) default project-scoped — candidates promote to the relevant ext's `skills/` dir (symmetric, PR-reviewable); global/personal candidates are an explicit escape (→ `~/.pi/agent/`). (b) Guard: wayfinder harvest must NEVER treat `.planning/knowledge/` as an effort dir. (c) Not redundant with the L2 knowledge graph — different layers (untested candidate drafts vs converged curated knowledge); skill-worthy graph-cards can seed candidates. (Resolved during charting by user decision.)

## Not yet specified

- **Feedback / calibration loop**: once candidates are captured + promoted (or rejected), does the agent learn to calibrate "skill-worthy" judgment over time (e.g. a rejected-pattern memory)? Can't ticket precisely until tickets 03 (recognition criteria) + 05 (promotion path) land — the feedback signal depends on both.
- **Exact template wording**: the precise prompt-block text follows from ticket 03's recognition-criteria decision; too coarse to ticket now.

## Out of scope

- **Broad improvements to wayfind / superpowers beyond the bridge.** This effort is the learning→skill export bridge only. The status-bar overlay redesign (PR #911, `db2f9ee`) was a separate detour, already shipped. Other wayfind-command or superpowers-skill polish is a fresh effort if wanted.
