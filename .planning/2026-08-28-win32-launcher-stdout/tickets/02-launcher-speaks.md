---
type: task
blocking: 01
status: open
---

# 02 — Make the win32 launcher deliver output; verify asserts PASS

## Question

Can the user-facing launcher chain (`s2-agent.cmd` / `s2-agent.ps1`) be made
to relay the runtime's stdout on windows-latest — and the verify lane flipped
from skip-classification back to honest PASS?

## What to build

Implement the fix path ticket 01's verdict selects: (a) if a newer bun
unblocks it — bump the repo-wide bun pin per D2 (single runtime, D7), gated
on full devops `local_ci` AND `main-health` green (bun-1.4 divergence traps
are recorded; the gates are the blast-radius guard), version-split ONLY as a
gate-red fallback with the deviation recorded; or (b) if no bun version
fixes it — a shim-side workaround (leading candidate from the measurement:
spawn bun with no inherited console, e.g. DETACHED / CREATE_NO_WINDOW from
the .cmd/.ps1 entry, forcing stdout-handle writes; prove it with a diag
variant BEFORE rewriting the shipped shims). Then flip the verify recipe's
ext-load / tools-probe probes from `skip` back to real verdicts keyed on
launcher-mediated stdout being nonempty. `crossos-deploy-verify`
windows-latest must be green with `pass` verdicts (not skip) and the
layer-diag table showing nonzero bytes for the launcher variants.

## Acceptance

- [ ] Launcher-mediated probes return nonzero stdout on windows-latest —
      diag table receipt (ps1-direct / cmd-shim byte counts > 0).
- [ ] Verify recipe asserts these as PASS/FAIL (skip-classification
      removed or narrowed to a true-unknown only); windows-latest run green
      with `pass` verdicts.
- [ ] If the pin was bumped: `local_ci` + `main-health` green receipts; if
      version-split fallback taken: deviation + reason recorded here.
