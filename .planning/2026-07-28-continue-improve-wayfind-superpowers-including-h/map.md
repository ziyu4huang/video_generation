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
- [Capture moment + source layer](tickets/01-capture-moment-and-source-layer.md) — **main-session, agent-judged**: on-save (the agent's own `memory` write meeting the skill-worthy criteria) OR on-recurrence (`memory_search` surfaces the same lesson ≥2×). Source = **L1-raw** (candidate `evidence` = the L1 memory id); L2 converged graph-cards stay an auxiliary seed path, not a live trigger. Background-review saves picked up via recurrence-search (acceptable lag; no review-child coupling in v1). Unblocks ticket 03.
- [Template content + injection mechanics](tickets/03-template-content-and-injection-mechanics.md) — **extend the memory-policy block's "Procedural skills" subsection** (full + _COMPACT). Skill-worthy bar = reusable + **procedural (HOW, not a fact)** + not-already-a-skill + non-trivial. Capture = `.planning/knowledge/<name>.md` (5 fields). Reconciliation: candidate path = lesson-derived procedures warranting TDD; `skill_manage` direct stays for deliberate quick procedures; promotion is separate via writing-skills test-first. Full + compact template text drafted (plan-don't-do: implementation is post-map). Graduates the "exact template wording" fog; unblocks ticket 04.
- [Dedup / quality gate](tickets/04-dedup-and-quality-gate.md) — **defer to promotion, no capture-time gate.** The important dedup (candidate ≈ existing L3 skill) is already caught by writing-skills' RED phase; candidate-vs-candidate dups are acceptable cleanable staging noise; capture stays light (T01); the worse failure is false-positive suppression (a genuine candidate lost) — deferral accepts clutter to avoid it. Mechanism = RED phase (existing) + free filesystem name-collision signal. Leaf ticket — frontier narrows to {05}.
- [Promotion path into writing-skills TDD](tickets/05-promotion-path-into-writing-skills-tdd.md) — **writing-skills integration**: a "candidate seed" step in writing-skills' RED phase — the candidate's `trigger/symptom` becomes the pressure scenario; it FEEDS RED, never skips it (Iron Law respected). Who fires: **either (transparent)** — agent-proactive-transparent as common path, user-deliberate equally valid; promotion always visible, user can veto. Lifecycle: **consumed-removed** — candidate is transient; promoted → content → SKILL.md + provenance (memory id) + candidate deleted; rejected → candidate deleted, lesson + its not-skill status persists as a memory. Drafted step text (plan-don't-do). Graduates the feedback-loop fog (rejection→memory = the calibration signal). **LAST TICKET — destination reached.**

## Status

✅ **All 5 tickets closed · all fog graduated · destination reached.** The learning→skill export bridge is fully designed end-to-end (capture moment + source → candidate artifact → template + injection → dedup gate → promotion path). Ready for `/wayfind done` (harvest) and the **implementation phase** (post-map, plan-don't-do done):
1. Edit `MEMORY_POLICY_PROMPT`'s "Procedural skills" subsection (full + `_COMPACT`) per ticket 03.
2. Add the "candidate seed" step to writing-skills' RED phase per ticket 05.
3. Create `.planning/knowledge/` (the candidate staging dir; ensure the wayfinder harvest guard knows it).

The former **"Feedback / calibration loop" fog graduated**: ticket 05's rejection→memory lifecycle IS the calibration signal — a rejected lesson persists as a memory with its not-skill status, surfaced by future `memory_search` recurrence, calibrating the agent's skill-worthy judgment over time. No separate mechanism needed; calibration is an emergent property of the lifecycle.

## Out of scope

- **Broad improvements to wayfind / superpowers beyond the bridge.** This effort is the learning→skill export bridge only. The status-bar overlay redesign (PR #911, `db2f9ee`) was a separate detour, already shipped. Other wayfind-command or superpowers-skill polish is a fresh effort if wanted.
