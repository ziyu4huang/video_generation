> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-26-critical-path-integration-tests

## Destination

Critical-path integration tests for **superpowers + wayfind** — behavior-focused
coverage of the paths most likely to break in real use (SDD fix-loop cross-round
memory, routing disk-state transitions, bootstrap injection lifecycle,
skill-exclude under real pi), built **lean** on the existing probe-runner
(real-pi A/B) + buntest with **no new infrastructure**. The route is clear when
the critical-path set is enumerated + risk-ranked and the CI integration
strategy is decided — then the test-writing graduates to a plan.

## Notes

- **Domain:** test depth + correctness for `bun-apps/pi-agent-ext-superpowers`
  (125 tests, 2 src/332 LOC, 14 skills) and `bun-apps/pi-agent-ext-wayfind`
  (173 tests, 12 src/1778 LOC, 7 skills). Both green + lean post-PR #832.
- **Fidelity:** lean — extend `scripts/probe-runner.ts` (real-pi A/B, built for
  the Phase-3 skill-unload audit) + buntest. No new harness, no ported eval rig.
- **Bar:** critical-path integration, NOT line/branch-coverage chasing.
- **Skills every session:** grilling, domain-modeling, test-driven-development,
  verification-before-completion (excluded by default now — re-enable with
  `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` if a session needs it loaded).
- **Standing pref:** the upstream RED/GREEN eval rig is explicitly OUT of scope
  this effort (lean choice); revisit only if 01 shows the SDD fix-loop can't be
  adequately tested with probe-runner.

## Decisions so far

- [01 — Enumerate + risk-rank critical paths](tickets/01-enumerate-and-risk-rank-critical-paths.md) — top risks: **piBoundaryOverrides routing** (zero test coverage, [D]) + **SDD fix-loop cross-round** (smoke-only, [L]); then skill-exclude-under-real-pi, sdd-workspace PLAN_FILE derivation, determinism jobs. Bootstrap lifecycle + wayfind effort detection already unit-covered (lower).
- [02 — CI integration strategy](tickets/02-ci-integration-strategy.md) — superpowers joins the matrix (1 line, mirror wayfind); real-pi probe-runner is **local-smoke-only**, CI gates on deterministic buntest ([D]→buntest/CI, [L]→real-pi/local).
- [03 — Prioritize queue + assertion pattern](tickets/03-prioritize-queue-and-assertion-pattern.md) — **graduated** (determined by 01+02, not separately grilled); queue = 01's rank, pattern = the [D]/[L] tag. Graduated into `plan.md`.

**All decisions resolved → test-writing graduated to [`plan.md`](plan.md) (2 deterministic tasks executable now: matrix slot + sdd-workspace golden test; real-pi probes documented as local-smoke follow-up).**

## Not yet specified

- **Per-path test design** — the exact buntest assertions (CI) + probe-runner
  case shape (local-smoke) per critical path. 02 settled the [D]→buntest/CI vs
  [L]→real-pi/local split; 03 finalizes the queue order + rubric/golden choice,
  after which each path graduates to its own test-writing task.

## Out of scope

- **Prompt-weight optimization** — closed by PR #832 (compression sweep +
  verification-before-completion default exclude). Not resumed here.
- **Skill-content quality** — the chosen axis is test depth, not skill polish.
- **New features/capabilities** — quality of what exists, not new surface area.
- **Porting the upstream RED/GREEN eval rig** — ruled out by the lean choice.
