---
effort: 2026-08-17-develop-pipeline
created: 2026-08-17
last: 2026-08-18
status: complete
---

# Wayfinder map: develop-pipeline

## Destination
The canonical agent development pipeline for this repo, as a diagram of record
plus enforceable handoff contracts:

    wayfind  ->  superpowers  <=>  subagents
   (decide)     (design/plan/     (execute:
                orchestrate)       bounded missions)

One spine of artifacts, one owner per stage, verified handoffs, and feedback
loops that route fog back to wayfind instead of improvising past it.

## Notes

- Closed 2026-08-17: spec M1-M5 executed as tickets 01-05, all closed; merged as
  PR #1582 (squash 769a50b9). Gates at close: wayfind 513/0, superpowers 132/0,
  repo 17/17.
- Harvest: next goal = first greenfield effort run fully under the codified
  pipeline (entry criteria + verify children + dispatch ledger), collecting
  ledger lines to validate the 150-260k/6-14 turn baseline.

### Diagram of record — stage spine

```
 DECIDE         SYNTHESIZE      DESIGN           PLAN             EXECUTE
 wayfind        wayfind         superpowers      superpowers      superpowers <=> subagents
 grill          to-spec         brainstorming    writing-plans    executing-plans / SDD
 ----------     ------------    --------------   --------------  --------------------------
 map.md    -->  spec.md    -->  brainstorm/ -->  plan.md    -->   tickets/ + sdd/
 routes +       settled         mockups +        tasks with      per-task reports +
 open Qs        decisions       ADR drafts       Run/Expected    recovery ledger

 handoff rule: the left artifact freezes at each arrow; unresolved fog flows
 back LEFT (any stage may reopen a map question — never improvise past one)
```

### Diagram of record — the execute loop (superpowers <=> subagents)

```
            +--------------------------------+
            | SUPERPOWERS - orchestrator     |
            | executing-plans (driver)       |
            | systematic-debugging (on red)  |
            +-------+--------------------^---+
     mission v       | self-contained     | final report
     brief           | task + tokenBudget | (mandatory, even
     (one            | + maxTurns         | on budget death)
     mission-group)  v                    |
            +--------------------------------+
            | SUBAGENT - isolated context    |
            | gate -> checkboxes -> commit   |
            | green work lands even if the   |
            | child dies (check git log      |
            | before redispatching)          |
            +-------+------------------------+
     green commit v
            +--------------------------------+
            | VERIFY child (read-only)       |-- red --> redispatch or
            | re-runs gates + sanity greps   |           systematic-debugging
            +--------------------------------+
```
In-session tools (either side): task-cockpit /goal + todo — subsumed, not a stage (D7).

The <=> is both arrows: missions/briefs flow down, reports/gate-results flow
up. The verify child is itself a read-only subagent — execution reviews itself
with the same primitive it executes with.

### Evidence base (from 2026-08-16-solution-extension-simplification, PR #1574)
- Dispatch shape that survives: one mission-group per child, tokenBudget
  150-260k, maxTurns 6-14, retryOnTransient false, mandatory final report.
- Verify child (read-only) after every write child; janitor child recovers
  budget-dead children — status, gate, check boxes, commit what is green.
- Turn count dominates child cost (~10k+ fixed overhead per turn) — prefer
  fewer, fuller turns over many exploratory ones.
- Remote CI stays disabled by design; local gates + pre-push hook are the bar.

## Decisions so far
- D1 One canonical home: .planning/<effort>/ holds every artifact
  (ADR-superpowers-0009); no-effort specs/plans land in .planning/specs|plans.
- D2 Routing: DECIDE/SYNTHESIZE -> wayfind; DESIGN/PLAN/EXECUTE -> superpowers
  (the using-superpowers bootstrap table).
- D3 Git sync/branch/PR/merge phases belong to the devops chain — never
  hand-rolled raw git for those phases.
- D4 The <=>-leg guardrails live in superpowers dispatching-parallel-agents
  (single source of truth after the full merge).
- D5 (Q1) Handoff contracts = skill entry-criteria: to-spec gets "map frozen (zero open
  Qs)"; writing-plans gets "spec settled (zero open decisions)"; executing-plans gets
  "every task has Run:/Expected:". Enforcement is social: verify child + plan review.
  No tool-gate linter unless drift proves we need one.
- D6 (Q2) Verify-child protocol lives in superpowers:dispatching-parallel-agents
  (single source of truth; every plan inherits it).
- D7 (Q3) task-coordinator (/goal + todo cockpit) is subsumed as an in-session tool —
  usable from either side of the execute loop; not a pipeline stage.
- D8 (Q4) Budget accounting = SDD progress.md ledger extension: one line per child
  (task, tokenBudget, maxTurns, outcome, commit SHA); 2026-08-16 effort is baseline.
- D9 (Q5) Map.md stays diagram of record; root CONTEXT-MAP.md created with a
  Pipeline section pointing here (fixes CLAUDE.md dangling reference).

## Not yet specified
<!-- none — grill 2026-08-17 resolved Q1–Q5; spec-ready (to-spec unblocked) -->

## Out of scope
- Re-restructuring the skills themselves — closed by
  2026-08-16-solution-extension-simplification.
- Remote CI enablement — permanently disabled by design.
- The MLX movie pipeline (python/mlx-movie-director) — a different pipeline.
