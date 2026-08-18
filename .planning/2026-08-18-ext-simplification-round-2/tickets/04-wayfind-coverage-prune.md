---
type: code
blocking: none
status: open
---

# 04 Wayfind coverage-guided prune (spec M4)

## Question
How much of wayfind's 10,585 TS LOC is genuinely dead (no coverage, no entry
reachability) — and can the package shrink ~20% with zero behavior loss?

## What to build
- Add "coverage" script to package.json: bun test --coverage.
- Census: modules with ~0% coverage AND not reachable from extensions/<X>.ts
  entry (or other live entrypoints: CLI, tests of public API). Record the
  census table in this ticket's completion note (module, LOC, coverage %,
  reachable-by, verdict).
- Prune candidates bottom-up; delete dead modules + their now-unused imports.
- If honest yield < 20% (target <=8,470 LOC), take what is real and record the
  shortfall — no live-code cuts to hit a number.

## Acceptance
- ( cd bun-apps/pi-agent-ext-wayfind && bun test ) green (513+); typecheck
  clean.
- LOC: <=8,470 OR documented shortfall with the census table.
- Census table committed in ticket completion / effort notes.
