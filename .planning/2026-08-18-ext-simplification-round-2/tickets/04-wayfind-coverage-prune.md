---
type: code
blocking: none
status: done
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

## Completion 2026-08-18 — documented shortfall (the honest outcome)
Coverage census (bun test --coverage, 513/0 green): ALL 27 src files >= 60%
line coverage (lowest: src/index.ts 60%, state.ts 76.9%, grill-handlers 81%).
Zero dead-path candidates: the only <=5% rows are gitignored dist/ build output
and the extensions/wayfind.ts registration entry (0% = untested shim, ALIVE —
3 external importers). REAL source baseline is 4,210 LOC (src/+extensions/*.ts
incl. 3 test files) — the spec's 10,585 figure was a find+xargs measurement
artifact (whole-package *.ts incl. tests/skills/fixtures). Per this ticket's
own rule: no live-code cuts to hit a number; yield = coverage script added +
census recorded. -20% LOC target NOT MET and correctly so — round 1 already
pruned this package; it is coverage-healthy.
Observation for follow-up (out of scope): pi-agent/run-dir/manifest.json:70
lists pi-agent-ext-wayfind while static-extensions.ts:92 also registers it —
verify not double-registered.
