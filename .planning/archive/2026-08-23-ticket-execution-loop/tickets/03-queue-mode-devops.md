---
type: task
blocking: 01
status: closed
---

# 03 — Queue mode in devops (self-reflect-next-goal + devops-workflow)

## Question

How does the next-goal file carry a ticket queue across sessions and terminate when it drains?

## What to build

`self-reflect-next-goal` gains a queue mode inside the pinned v2 shape — no new frontmatter
keys or headings (validator: five `##` headings exact → `src/validate-next-goal.ts:26`, exact
key set :34, `Done when` ≥1 open box :158-162, Ranked 3–5 entries :166-168):

- **READ**: the Ranked list mirrors the effort's user-chosen `Execution order` (map.md); on
  disagreement, surface drift instead of silently picking.
- **WRITE**: boundary discipline — after any verified + merged ticket in a multi-ticket effort,
  supersede the file even mid-session so `LATEST-next-goal.md` always names the queue head;
  queue-drain termination — when no ticket remains, the successor's head = effort close-out
  (map status: complete) with fold-back/audit items in Ranked — never a self-perpetuating goal.
- **EXECUTE**: recognize the queue shape (Immediate steps naming a ticket, Done when = its
  acceptance), run the head end-to-end, continue in-session while fresh or stop at the boundary;
  the loop stops when the successor reports the queue drained.

`devops-workflow` gets one cross-ref line at the merge close-out (≈line 235-238): when the PR
closed a queue ticket, supersede the next-goal file with the next ticket as head rather than a
fresh goal.

## Acceptance

- [ ] `self-reflect-next-goal`: READ drift rule, WRITE boundary + termination, EXECUTE queue-shape recognition all present.
- [ ] No validator changes; `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts` doctor still exit 0.
- [ ] `devops-workflow` merge close-out cross-ref line present.
- [ ] Devops canonical gate green: `( cd bun-apps/s2-agent-ext-devops && bun run test && bun run check )`.

## Resolution

2026-08-23 — shipped in this PR. `self-reflect-next-goal` gained queue mode inside the pinned v2
shape (no validator changes): READ drift rule (Ranked mirrors the effort's user-chosen
`Execution order`; surface disagreement); WRITE boundary discipline (supersede at every ticket
boundary, mid-session) + queue-drain termination (drained queue → successor head = effort
close-out, the loop stops); EXECUTE queue-shape recognition (head ticket + ticket acceptance as
Done when, run end-to-end, stop at the boundary). `devops-workflow`'s merge close-out gained the
cross-ref line (queue ticket closed → successor head = the next ticket). Trigger layer
(`using-s2-agent-skills` gates) + CLAUDE.md pointer updated. Verified: devops `bun run test`
821 pass / 0 fail + `bun run check` tsc clean; next-goal validator doctor exit 0.
