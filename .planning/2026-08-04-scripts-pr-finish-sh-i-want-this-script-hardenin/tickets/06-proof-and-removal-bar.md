type: grilling
status: closed
claimed: 2026-08-04 grill-session
resolved: 2026-08-04
blocked by: 03-flake-judgment-design, 05-flake-diagnosis-data-source

## Question

What does "**once prove works**" mean concretely — the bar at which
`scripts/pr-finish.sh` is deleted? The user's destination made script-removal
contingent on proof, but left "proof" undefined.

Candidate bars (recommendation first):

- **(a) ⭐ Dogfood primary + light deterministic test** — delete `pr-finish.sh` once the
  `land-pr` skill lands the next **~3 real PRs** on this repo end-to-end (CI watch →
  judgment → merge → worktree cleanup) **without falling back to the script**, PLUS a
  small test for the deterministic parts (the worktree-cleanup sequence from #04).
  Rationale: the skill's value is *judgment under real CI flakiness* — hard to fake in a
  unit test — so real lands are the honest proof; the deterministic cleanup still earns a
  cheap regression guard.
- **(b) Test-harness bar** — scripted CI scenarios (flake / BEHIND / BLOCKED) asserting
  the judgment fires correctly, mirroring `scripts/pr-finish.test.ts`. Deterministic, but
  testing prose-judgment is awkward and may not catch real-world flakes.
- **(c) Both, fully** — dogfood 3 PRs AND a full judgment-scenario harness. Safest,
  heaviest.

Depends on #03 (rubric-vs-discretion decides what's even testable) and #05 (data source
decides whether judgment can be exercised through a typed tool). Grill to the exact
number of dogfood lands + which deterministic parts get a test.

## Resolution

**Bar = dogfood + targeted unit tests (option a).** Delete `scripts/pr-finish.sh` once
BOTH hold:

1. **Dogfood** — the `land-pr` skill lands the next **~3 real PRs** end-to-end (CI watch →
   flake-judgment → merge → worktree cleanup) **without falling back to `pr-finish.sh`**,
   including **≥1 flake-rerun** case (PR #1023 — docs-only, `test · pi-agent-ext-movie-director`
   timed out — is the canonical candidate).
2. **Targeted unit tests** — pass for the DETERMINISTIC logic only:
   - the rubric's decision function: given (check `name` → package, `state`, PR changed-files)
     → {rerun-once | surface}, incl. the monorepo/unmappable + shared-code-guard branches;
   - the worktree-cleanup command sequence (#04's 4 steps).

The **escape-hatch UX** and **live-flake judgment** stay dogfood-only (not unit-testable —
that's the point of dogfooding them). Splits along #03's deterministic-vs-discretion seam;
#05 means no typed-tool test surface is needed (the rubric runs on raw `gh pr checks` JSON a
test can fixture).

**Last ticket — frontier clear, destination reached → closing ceremony.**
