# Spec — ticket execution order + next-goal self-loop

## Problem Statement

Multi-ticket efforts execute in an agent-derived order (seed's topo sort over `blocking:`
edges) that is never presented for confirmation, and the devops handoff already flavors toward
a ticket queue (the live `output/next-goal-*.md` writes "Immediate steps = ticket 08; Ranked =
09/10") without any boundary discipline or end condition. Result: the user never chooses the
order they want, and running an effort to completion across sessions depends on the human
re-aiming the next goal each time instead of the system carrying the queue.

## Solution

1. **Confirm-gate at start**: after `/wayfind seed` (or at executing-plans load), the agent
   presents the derived order with hard `blocking:` edges marked (no choice) and parallelizable
   pairs marked (choice), and asks confirm-or-rechoose. Single open ticket / fully-determined
   queue → one-line confirm.
2. **Durable order record**: the chosen order is written as one `**Execution order:**` line
   inside the effort map's `## Tickets` section (parser-inert — `readMap` derives tickets from
   the `tickets/` directory, `src/map.ts:75-93`). The devops next-goal file's `Ranked next
   goals` mirrors it.
3. **Boundary-carry self-loop**: after any verified + merged ticket in a multi-ticket effort,
   the successor next-goal file is written (strict v2 format) with `Immediate steps` = the next
   ticket in the chosen order and `Done when` = that ticket's acceptance. The session then
   either continues to the next ticket inline (while fresh) or stops so "hands on next goal"
   resumes the queue head.
4. **Termination**: when the queue drains, the successor's head = effort close-out (map status
   complete); the loop ends. Never invent a self-perpetuating goal.

## User Stories

- As the developer, I want the agent to show me the ticket order (with where I have no choice)
  before execution starts, so I can confirm or reorder.
- As the developer, I want the chosen order recorded in the effort map, so a fresh session
  mid-effort still knows what was chosen.
- As the developer, I want each ticket boundary to write the next-goal file automatically, so
  the next session ("hands on") picks up the queue head without me re-deciding.
- As the developer, I want the loop to end with an effort close-out when all tickets are done,
  so I don't get a goal that invents new work forever.
- As the agent, I want the next-goal format to stay validator-passing, so the queue mode ride
  the existing pinned format instead of forking it.

## Implementation Decisions

- **D1 confirm-gate at start** — presentation + one-shot ask; blockers marked; parallelizable
  pairs marked; fast path for no-choice queues. (map.md D1)
- **D2 write + continue if fresh at boundaries** — file always superseded at a ticket boundary;
  in-session continuation until the smart zone (~140-150k used) then boundary stop. (map.md D2)
- **D3 `Execution order:` line in map.md `## Tickets`** — single line, parser-inert, mirrored
  by the next-goal Ranked list. (map.md D3)
- **D4 queue mode inside the pinned format** — facts under the five existing headings only;
  no frontmatter keys, no new headings, `Ranked next goals` stays 3–5 entries (remaining queue
  + close-out + fold-back/audit items). (map.md D4)
- **D5 doc-only** — 6 SKILL.md files; no code, no validator changes. (map.md D5)

## Testing Decisions

- **Canonical package gates** (a doc edit must not break them): wayfind `bun run test` (check +
  test:unit + test:probe), superpowers `bun run test` (check + test:unit), devops `bun run test
  && bun run check`.
- **Next-goal doctor**: `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts` — exit
  0 on the live `output/` and on the pressure-probe's successor file.
- **Pressure probe (writing-skills TDD, GREEN pass)**: one fresh subagent with the updated
  `executing-plans` wording against a fixture 2-ticket effort — must (a) ask confirm-or-rechoose
  before executing, and (b) after "ticket 1 done + merged" produce a validator-passing successor
  whose Immediate steps name ticket 2. Baseline (no-skill) run was not measured — see map.md Fog
  of war.

## Out of Scope

- No changes to the next-goal validator, its tests, or the v2 format.
- No new wayfind subcommands (no `/wayfind order`); the seed order + gate is procedure.
- No changes to `subagent-driven-development`'s continuous-execution principle (no new pauses;
  the ledger remains the intra-session recovery).
- CLAUDE.md unchanged (the `Execution order` line lives inside the existing `## Tickets` section
  — no house-shape amendment needed).

## Further Notes

- The live handoff file that inspired this (`output/next-goal-20260823-135435.md`) already
  follows the queue shape informally; after this lands, its successor can adopt the boundary
  discipline without rewriting the format.
