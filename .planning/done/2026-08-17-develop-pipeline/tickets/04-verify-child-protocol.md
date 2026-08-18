---
type: task
blocking: 03
status: closed
---
# 04 — verify-child protocol in dispatching-parallel-agents

## Question
Who mechanically verifies a write child's landing, and what happens on red?

## What to build
Add `## Verify-child protocol` to `bun-apps/pi-agent-ext-superpowers/skills/dispatching-parallel-agents/SKILL.md`: after every write child, dispatch a read-only verify child that re-runs the task's own gates AND the repo-wide gates (extension-entry typecheck `typecheck:ext` plus the task's sanity greps); on green, record the ledger line (format per executing-plans `## Dispatch ledger`); on red, redispatch a janitor child (status -> gate -> check boxes -> commit green work) or escalate to systematic-debugging — never paper over. Cite the archify regression (PR #1574: package tests green, repo-wide typecheck red) as the motivating case. Fidelity protocol + UPSTREAM.ref row.

## Acceptance
- [ ] dispatching-parallel-agents SKILL.md has `## Verify-child protocol` (read-only child; task gates + typecheck:ext + greps; ledger line on green; janitor/systematic-debugging on red)
- [ ] archify motivating case cited
- [ ] rebalance run; superpowers `bun test` green (132 baseline)
- [ ] UPSTREAM.ref LOCAL-DIVERGENCES row added

## Resolution
Done — verify-child protocol in dispatching-parallel-agents: read-only verify child re-runs task gates + typecheck:ext + greps after every write child; ledger on green, janitor/systematic-debugging on red; archify PR #1574 cited, c2e5fa76.
