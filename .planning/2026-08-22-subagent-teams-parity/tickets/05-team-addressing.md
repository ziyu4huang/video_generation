# Ticket 05 — team-addressing

status: closed
closed: 2026-08-22 — PR #1834 merged (main 1d37ec7d), squash-titled "feat(subagent): parent-brokered sibling routing + live team roster (teams parity 05/08)". Merged through merge-pr-after-ci (CLEAN, scope-verified 6 files). Independent reviewer: APPROVE, 4 minors — all fixed pre-merge in f34c8ceb (running-branch race that dropped a raced reply, relay-before-delivery ordering, missing catch on a throwing steer, unpinned guards → 3 new tests).

## Resolution (2026-08-22, branch feat/subagent-teams-parity-05-addressing)

- Sender identity groundwork: `createSendMessageTool` gains `selfName`;
  `buildSpawnOptions` swaps a NAMED child's extensionTools `send_message` def for a
  selfName-stamped instance (same tool NAME — allowlists / applyToolPolicy untouched;
  `makeChildSendTool` dep for wiring tests). The stamp defaults the child's
  `to:'main'` identity; unnamed children keep the shared parent instance (documented
  residual seam on map.md).
- Brokered routing (spec §3): relay to the parent (`formatSiblingRelayNotification`,
  2000-char cap) + deliver into the target (steer when running; fresh
  fire-and-forget exchange when idle, reply relayed on settle via
  `formatSiblingReplyNotification`). The relay publishes only once delivery is
  assured (running branch: after send resolves — throw/terminal publish nothing).
  Unwired bus refuses rather than delivering silently.
- Protocol envelopes from a child at a teammate refuse — closes the hole where a
  child's `shutdown_request` would run the parent-grade two-stage stop.
- Roster: `list_subagent_runs` `list` appends `renderLiveRoster` (name, status,
  model, agentId, recency) after the archive, unfiltered by status/cwd/limit.
- CONTEXT.md: `team` / `teammate` / `brokered routing` terms; ticket-02 seam
  paragraph replaced by the contract; nested-main→root documented as contract.
- Tests: `tests/team-addressing.test.ts` (19). Package 657 pass; tsc + biome green;
  local_ci pass.

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
