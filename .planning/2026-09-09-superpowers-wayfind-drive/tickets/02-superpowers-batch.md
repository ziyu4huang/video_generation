---
type: task
status: closed
resolved: 2026-09-09
---

# t02 — superpowers `-p` batch (C1–C4 + C8)

Findings → minimal fixes per D4 rank → `bun run check && bun run typecheck
&& bun test` in s2-agent-ext-superpowers → redeploy via deploy-cli → re-run
SAME cases on the deployed leg → paired receipts.

Acceptance: every case GREEN or a recorded gap with the preserved red
receipt; upstream-fidelity + skills-inventory tests still green.


## Resolution

C1 GREEN (machinery probe + model-visible YES both legs), C2 behavioral GREEN (C2b: brainstorming+TDD read, work red-to-green), C3 PASS (TDD read), C4 PASS (exclude knob authoritative), C8 GREEN (bootstrap routing table cited verbatim, no reads). Honest nulls - no fix justified by evidence.
