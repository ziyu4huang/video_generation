---
type: task
status: open
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

- [ ] At least two bun versions measured via the dispatch input; receipts
      (run ID, version, per-variant byte counts) recorded in the ticket
      close-out.
- [ ] The real upstream issue identified or filed (link recorded); the
      wrong `bun#12108` attribution corrected in the workflow comment and
      the verify-recipe note.
- [ ] A one-line fix-path verdict recorded: "upgrade unblocks (≥ vX.Y.Z)"
      or "no fixed version — shim workaround required".
