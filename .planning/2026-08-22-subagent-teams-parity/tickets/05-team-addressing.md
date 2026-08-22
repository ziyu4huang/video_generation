# Ticket 05 — team-addressing

status: open

## Goal

Teammates: sibling `to: <name>` addressing brokered through the parent, plus a live
roster the model can discover.

## Steps

1. `send-message-tool.ts` — child→sibling routing: parent-brokered (delivered into
   the target's steer queue AND surfaced to the parent as a followUp notification);
   never a direct child→child channel.
2. `list_subagent_runs` `list` action gains a `live` roster section (names, status,
   model, agentId) — one action addition, no new tool.
3. CONTEXT.md terms: `team`, `teammate`, `brokered routing`; `_Avoid_:` "mesh",
   "peer-to-peer".

Depends on: tickets 01 + 02.

## Tests

- NEW `tests/team-addressing.test.ts` — roster accuracy, brokered delivery to idle
  and running siblings, unknown-sibling error, notification preview cap.

## Acceptance

Subagent `bun run test` green; smoke: two named agents, sibling message routed,
parent notified.
