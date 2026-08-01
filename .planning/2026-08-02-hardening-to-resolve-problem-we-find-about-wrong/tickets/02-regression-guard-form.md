# Regression-guard form

type: grilling
claimed: pi-agent (main session, 2026-08-02)

## Question

The destination requires a test that fails if `docs/superpowers/` ever receives
an artifact again. What form should that guard take? (R2: specs/plans are
prose-only, so we cannot script-intercept the write — the guard is the
enforcement for those two kinds.)

Candidate answers (grill one at a time, with a recommendation):

- **Both: injected-text assertion + repo lint.** *Recommended.*
  (a) A unit test asserting `piBoundaryOverrides()` output contains an
  **unconditional** "never write to `docs/superpowers/`" rule (catches the text
  regressing back to effort-gated language); (b) a repo lint (or pre-commit /
  CI check) that fails if any *new* tracked file lands under `docs/superpowers/`
  or `.superpowers/sdd/` (catches actual leakage regardless of cause).
- **Injected-text assertion only.** Cheapest; guards the text but not actual
  file leakage. Weak against a model that ignores injected text (the failure
  mode we hit).
- **Repo lint only.** Catches real leakage but not the text regressing — a
  future edit could re-introduce effort-gated language silently.

Blocked by: _(none — frontier)_

## Notes

- The lint must distinguish *new* files under `docs/superpowers/` from the one
  pre-existing legitimate file (`docs/superpowers/audit/2026-07-18-…md`) —
  baseline the allowed set, fail on anything beyond it.
- Consider whether the lint lives in `pi-agent-ext-superpowers` tests or at the
  repo root (it spans all extensions).

## Resolution

**Decision: both — injected-text assertion + repo lint (defense in depth).**

- **(a) Unit test** asserting `piBoundaryOverrides()` output contains an
  UNCONDITIONAL "never write to `docs/superpowers/`" rule (no "when an effort
  is active" conditioning on the avoidance). Catches the root cause: the text
  regressing to effort-gated language.
- **(b) Repo lint** that fails if any NEW tracked file lands under
  `docs/superpowers/` or `.superpowers/sdd/`. Baselines the allowed set
  (currently just `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md`)
  and fails on anything beyond it. Catches actual leakage — the failure mode
  that bit us.

Rationale: the failure we hit was a LEAK (lint's job); its root cause was
weak/conditional TEXT (assertion's job). Either alone leaves a gap — defense in
depth (cf. systematic-debugging `defense-in-depth.md`).

Deferred to ticket 04 (implementation detail, not a decision): where the lint
lives — `pi-agent-ext-superpowers` tests vs repo-root CI (it spans all
extensions).

Status: closed (2026-08-02)
