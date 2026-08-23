---
type: task
status: closed
---

# 01 — Order gate in wayfind (to-tickets + ask-matt)

## Question

When a multi-ticket effort is ready to execute, how does the agent surface the suggested ticket
order so the user chooses it — and where does the chosen order get recorded durably?

## What to build

After `/wayfind seed <effort>` (the chain-wiring step that produces the topo-sorted
`task_plan.md`), the agent presents the suggested execution order with hard `blocking:` edges
marked (no choice) and parallelizable pairs marked (choice), and asks confirm-or-rechoose.
The chosen order is recorded as one `**Execution order:**` line inside the effort's `map.md`
`## Tickets` section (parser-inert — `readMap` derives tickets from the `tickets/` directory,
`src/map.ts:75-93`), and the next-goal Ranked list mirrors it. Single open ticket /
fully-determined queue → one-line confirm, not a full prompt. The `ask-matt` multi-session
branch gains the gate bullet and the loop-carry bullet ("between tickets the handoff is the
devops next-goal file; hands on next goal resumes the queue head; the loop ends when the
effort's queue drains").

## Acceptance

- [ ] `to-tickets` Chain wiring: seed → present order (blockers marked as no-choice, choice pairs marked) → confirm-or-rechoose → record `Execution order` line in map.md `## Tickets`.
- [ ] Fast path defined: single open ticket / fully-determined queue → one-line confirm.
- [ ] `ask-matt` main-flow multi-session branch: gate + next-goal-carry bullets present.
- [ ] Wayfind canonical gate green: `( cd bun-apps/s2-agent-ext-wayfind && bun run test )`.

## Resolution

2026-08-23 — shipped in this PR. `to-tickets/SKILL.md` gained the confirm-gate wiring in the
chain flow (seed → present the suggested order with hard `blocking:` edges marked no-choice and
choice pairs marked, confirm-or-rechoose, record the chosen order as the `Execution order` line
in map.md `## Tickets`) plus the one-line fast path for single-ticket / fully-determined queues;
`ask-matt`'s multi-session branch gained the gate bullet and the loop-carry bullet ("between
tickets the handoff is the devops next-goal file; hands on next goal resumes the queue head;
the loop ends when the effort's queue drains"). Verified: wayfind `bun run test` 467 pass / 0
fail; pressure probe — a fresh subagent presented the confirm-gate before execution and its
two wording findings were fixed.
