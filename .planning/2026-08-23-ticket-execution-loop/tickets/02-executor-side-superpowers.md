---
type: task
blocking: 01
status: closed
---

# 02 — Executor side in superpowers (executing-plans + subagent-driven-development)

## Question

How does the executor honor the user-chosen order and carry the queue over ticket boundaries?

## What to build

`executing-plans` gains an order-checkpoint in Step 1 (Load and Review Plan): if the plan is
ticket-derived (task_plan.md phases / effort tickets), present the chosen order (map.md
`Execution order` line when present, else the phase order), ask confirm-or-rechoose before
creating todos; one-line confirm for single-ticket / fully-determined plans. Its close-out
(Step 3) becomes queue-aware: after all tasks verified and before/with
finishing-a-development-branch, if the effort has remaining tickets in the chosen order, write
the successor next-goal per self-reflect-next-goal's WRITE protocol (Immediate = next ticket,
Done when = its acceptance, Ranked = remaining queue + effort close-out), then continue to the
next ticket in-session while fresh or stop at the boundary; if no tickets remain, write the
close-out successor. `subagent-driven-development`'s Finish gains one paragraph: when the plan
was seeded from tickets and tickets remain, the close-out's next-goal Ranked list mirrors the
remaining queue — the ledger is the intra-session recovery, the next-goal file the inter-session
one; the "never pause between tasks" principle stays intact.

## Acceptance

- [ ] `executing-plans` Step 1: ticket-derived plan → order checkpoint (source: map.md `Execution order` line, else phase order) → confirm-or-rechoose before todos.
- [ ] `executing-plans` close-out: remaining tickets → successor next-goal (Immediate = next ticket, Done when = its acceptance) + continue-if-fresh / stop-at-boundary; queue drained → close-out successor.
- [ ] `subagent-driven-development` Finish: queue-mirror paragraph present, no pause-principle change.
- [ ] Superpowers canonical gate green: `( cd bun-apps/s2-agent-ext-superpowers && bun run test )`.

## Resolution

2026-08-23 — shipped in this PR. `executing-plans` gained the Step-1 order checkpoint
(ticket-derived plans → present the map.md `Execution order` line, else the phase order,
confirm-or-rechoose before creating todos; one-line confirm for single-ticket /
fully-determined plans) and the queue-aware close-out (remaining tickets → successor next-goal
per the WRITE protocol, then continue-if-fresh / stop-at-boundary; drained queue → close-out
successor). `subagent-driven-development`'s Finish gained the queue-mirror paragraph (ledger =
intra-session recovery, next-goal file = inter-session carry; the never-pause principle
unchanged). Fixture rebaseline per ADR-superpowers-0004: `upstream-skills/executing-plans.md`,
`upstream-skills/subagent-driven-development.md` + `UPSTREAM.ref` re-baselined (initial +
probe-driven wording fix) and the fixtures digest re-recorded. Verified: superpowers
`bun run test` 157 pass / 0 fail.
