---
type: task
blocking: 02
status: open
---

# 03 — Record the contract; refresh the deployed dist

## Question

What is the durable record of how the win32 launcher contract stands, and
does the deployed local dist finally match main HEAD?

## What to build

Two closes. (1) Record whichever branch ticket 02 took: if the launcher now
speaks, a short docs/ADR note stating the contract ("win32 entries relay
runtime stdout; requires bun ≥ the measured version" — ADR only if the
decision shape is hard-to-reverse + surprising, else the effort map's
Decisions + the workflow comment suffice); if ticket 02 landed the
skip-ratification instead (unfixable path), write the ADR-devops formally
ratifying the skip-classification contract and the documented user
workaround. (2) Refresh the stale local dist: run
`bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts` so `<outRoot>/current`
carries the 5+ merged commits it currently lacks (incl. #2108 /loop
consolidation, #2113 pathology injection), and confirm the automatic
post-deploy `verify-deploy-e2e` (boot + ext-load + model call) exits green.

## Acceptance

- [ ] Contract recorded (ADR-devops or map Decisions + docs, per the
      hard-to-reverse bar) with the measurement receipts cited.
- [ ] Local dist redeployed from main HEAD; verify-deploy-e2e green receipt
      (version string + verdicts) captured in the close-out.
