---
type: task
blocking: 05
status: open
---

# 04 — USB4 eval gate: resource-tier vs flat generic-card A/B

## Question
On the USB4 corpus, does the resource tier retrieve better than the cheap baseline (this morning's generic-card path scaled to the same corpus)?

## What to build
The parity-D14/D25-style gate: author ~20 English questions answerable from spec section content (held in the effort, written before running arms); run three arms twice each — (a) resource-tier recursive, (b) flat KNN over resource L2 rows, (c) generic-card lane over the same chapters (the morning path, `zk_ingest --source generic`); record hit@5 + MRR per arm in the ticket receipt. Gate: recursive must beat (b) on both metrics, and beat or clearly justify against (c), before any tool-surface wiring. A loss records the numbers and keeps the lane opt-in CLI-only (no shame, no silent drop).

## Acceptance
- [ ] Question set (~20) committed with the effort before any arm runs; authoring blind to results (derived from spec TOC/sections)
- [ ] All three arms run twice; hit@5 + MRR table in the ticket Resolution; reproduced winner noted
- [ ] Gate decision recorded (pass/fail + consequence) in the ticket and mirrored in the map Decisions
- [ ] No default/tool surface changed by this ticket regardless of outcome
- [ ] Independent reviewer subagent pass on the harness (question-set fairness, metric code) — or disclosed inline fallback
