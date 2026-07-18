# 07 — Enforcement surface: turn the invariant into a check, not a memory

## Question

Where does the convergence-completeness check **LIVE** so it's enforced
(structural) rather than remembered as scar-tissue? This is the "turn each
memorized avoidance into an enforced check" step for THIS subsystem — the
destination is only trustworthy if drift is caught by a gate, not by an agent
recalling a lesson.

### Candidates

- **(a) CI job.** A workflow runs `coverageReport` + `healthGate` over the
  vault and fails on `missing` / `sourceOrphaned` / dead-links beyond a
  threshold. Drift is caught at PR time.
- **(b) `/memory-health` command.** Surfaces true convergence state (coverage %
  + last receipt + dead-links/orphans) on demand — informational, not
  blocking. (Partially exists today — "now surfaces it" per memory.)
- **(c) Pre-commit / pre-merge hook.** Local gate before a converge-affecting
  change lands.
- **(d) Shutdown receipt.** The auto-converge hook writes a receipt a later
  `/memory-health` reads — closes the silent-fail gap (interacts with T03).

### Decide

- Blocking (CI) vs informational (health cmd) vs both? Given the user picked
  the broad trustworthy-convergence scope, likely (a) + (b).
- The gate threshold: 0 `missing`? allow N legacy until T05 migration runs?
- Does enforcement run against the primary worktree's vault only (dev
  worktrees have the disconnected-vault problem — T04)?

type: grilling
blocked by: 03
status: open
