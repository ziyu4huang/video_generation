---
type: task
status: closed
resolved: 2026-09-09
---

# t04 — pty command-body batch (C6–C7)

Findings → fixes (keywords table / guard copy / overlay text) → wayfind
gates → redeploy → re-run via `--sh <deployed>/s2-agent.sh`; snapshots
diffed pre/post. Cap ≤3 iterations per pty case (tui-drive lessons #3/#4:
paced real-wall-clock retries; live markers only for settle).

Acceptance: paired receipts; any residual red recorded as a gap.


## Resolution

TWO product defects found and fixed: F-C6a guard notify displaced before paint (fixed 95f1d2ad - status renders first, guard note last); F-C6b adoption did not bind the session when nothing claimable, voiding the guard and charting junk efforts (fixed 88611db1 - bind at adoption). Paired C6 receipt: RED-RED-PASS (9/9 checks on pinned deploy g88611db). C7 grill flow PASS both legs.
