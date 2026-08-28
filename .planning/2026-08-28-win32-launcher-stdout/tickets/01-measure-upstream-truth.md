---
type: task
status: done
---

# 01 — Measure the bun-version matrix and fix the upstream attribution

## Question

Which bun versions exhibit the win32 stdout-loss layer bug, and what is the
REAL upstream issue (the recorded `bun#12108` is provably the wrong bug)?

## What to build

Measurement + attribution truth, no launcher changes yet. Dispatch
`crossos-deploy-verify` via workflow_dispatch using the existing
`bun-version` input (added in #2110) against the newest 1.4.x and the
newest stable release line above it, capturing each run's layer-diag table
(bun-direct / ps1-direct / cmd-shim / cmd-echo / cmd-bun / cmd-bun-file
byte counts). Find the real upstream oven-sh/bun issue for "bun.exe as a
cmd/powershell child loses all stdout incl. file redirection, exit 0"; if
none exists, file one with the minimal repro we already have (cmd-echo 22B
vs cmd-bun 0B vs bun-direct full — that IS the repro). Correct the wrong
`bun#12108` note in `.github/workflows/crossos-deploy-verify.yml` and in
the verify-recipe note to cite the real issue (or the filed one). Record
the matrix receipts (run IDs + versions + verdicts) in this ticket's
close-out so ticket 02's fix path is a lookup, not a re-measure.

## Acceptance

- [x] At least two bun versions measured via the dispatch input; receipts
      (run ID, version, per-variant byte counts) recorded in the ticket
      close-out. — Matrix (2026-08-28/29): **1.4.0** = bug present (runs
      33120905596 / 33121706417: bun-direct 1299B `--ext-list` / 10045B
      `--help`; ps1-direct, cmd-shim, cmd-bun, cmd-bun-file ALL 0B);
      **1.3.14** = unmeasurable — windows workspace install fails earlier
      (`ENOENT: failed to link package: bun-types@1.3.14`, run
      33220283080), layer diag never ran; **canary
      1.4.0-canary.20260828.1** = not dispatchable — no GitHub release
      assets for canary tags, the deploy's D7 acquisition
      (GitHub-release-based) cannot fetch it. 1.4.0 IS the latest stable
      (released 2026-08-20) — no newer stable exists to test.
- [x] The real upstream issue identified or filed (link recorded); the
      wrong `bun#12108` attribution corrected in the workflow comment and
      the verify-recipe note. — Searched oven-sh/bun (multiple phrasings:
      stdout/pipe/console/powershell/batch/cmd.exe, 2026-08-29): NO
      matching issue exists; bun#12108 is "Bun terminates windows batch
      script" — batch termination, NOT stdout loss (fact-checked against
      the upstream page). Filing deliberately SKIPPED per user decision
      (D5) — recorded descriptively in-repo instead. Corrections landed in
      `.github/workflows/crossos-deploy-verify.yml` + 4 note sites in
      `deploy-e2e-recipe.ts`.
- [x] A one-line fix-path verdict recorded: "upgrade unblocks (≥ vX.Y.Z)"
      or "no fixed version — shim workaround required". — **Verdict: no
      fixed/newer version measurable (1.4.0 latest & buggy; 1.3.14 cannot
      install the workspace; canary unacquirable) — SHIM WORKAROUND
      REQUIRED** (ticket 02 takes the no-console-spawn route, diag-proven
      before any shipped shim rewrite).
