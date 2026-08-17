---
type: task
status: closed
---
# 03 — executing-plans entry criteria + dispatch ledger format

## Question
What gates plan execution, and how is every dispatched child's cost/outcome recorded?

## What to build
Two additions to `bun-apps/pi-agent-ext-superpowers/skills/executing-plans/SKILL.md`:
1. `## Entry criteria`: every task in the plan carries Run:/Expected: verification steps.
2. `## Dispatch ledger` section documenting the one-line-per-child format in the SDD progress.md:
   `[<task>] child(<tokenBudget>k/<maxTurns>t) -> done|died|janitored @<commit-sha>`
   citing the 2026-08-16 baseline (150-260k tokens, 6-14 turns; janitor recovery = status -> gate -> check boxes -> commit green work).
Fidelity protocol: rebalance + full test; UPSTREAM.ref LOCAL-DIVERGENCES rows for both sections.

## Acceptance
- [ ] executing-plans SKILL.md has `## Entry criteria` (Run:/Expected: per task)
- [ ] executing-plans SKILL.md has `## Dispatch ledger` with the exact line format + baseline
- [ ] rebalance run; superpowers `bun test` green (132 baseline)
- [ ] UPSTREAM.ref LOCAL-DIVERGENCES rows added

## Resolution
Done — executing-plans entry criteria (Run:/Expected: per task) + `## Dispatch ledger` one-line-per-child format with 2026-08-16 baseline; rebalance run, UPSTREAM.ref rows, 75db939d.
