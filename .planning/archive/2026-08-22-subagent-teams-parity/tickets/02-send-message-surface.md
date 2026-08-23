# Ticket 02 — send-message-surface

status: closed
closed: 2026-08-22 — PR #1818 merged (main 351fc22e), squash-titled "feat(subagent): send_message tool — named-agent follow-ups + parent bus (teams parity 02/08)". Merged through merge-pr-after-ci with local CI fully green in-branch (the first attempt caught a REAL gap — send_message missing owner-declared gating — fixed in-PR with the workflow gate family growing 5→6; no assume-ci-green needed). Independent reviewer subagent: 2 majors + 3 minors found, all fixed (cc59c4f0), re-review confirmed all RESOLVED ("ship it").

## Resolution (2026-08-22, branch feat/subagent-teams-parity-02-send-message)

- NEW `src/send-message-tool.ts` — `send_message {to, message, wait?, timeoutMs?, from?}`:
  resolves `to` name→agentId in the live registry; running → steer ("delivered", no separate
  reply); idle → awaited re-prompt (default), or `wait:false` fire-and-forget whose reply lands
  as a purpose-built `<task-notification>` (formatReplyNotification — inline reply, 4000-char
  cap, NO list_subagent_runs pointer: follow-up exchanges persist nothing, so the generic
  formatter's trailer would resolve to the first exchange's record). Terminal budget/turns
  failure refuses the message and releases the agent (both wait paths).
- NEW `src/parent-message-bus.ts` — process-singleton ParentMessageBus for `to:"main"`;
  wireParentMessageDeliverer wires followUp+triggerTurn ONLY when the host has sendMessage
  (an unwired bus returns an actionable error, never a silent no-op — review Major 1).
  Child identity = self-declared `from` (in-process children share the tool instance; no
  implicit session id exists).
- core-runtime: `LiveAgentHandle.send(): Promise<LiveAgentSendResult>` (structural;
  LiveAgentExchange satisfies it) — the routing seam. BackgroundRunManager gained raw
  `deliver(message)`; `notify()` routes through it.
- Registered in `extensions/subagent.ts` (+ activation family, bus wiring next to
  wireBackgroundDeliverer); barrel exports the new owned surface; spawn `name` param
  cross-links send_message; CONTEXT.md send_message term + a "seam ahead of its design"
  note (child→sibling direct routing + nested-main→root; tickets 04-05 own these).
- Independent reviewer pass (2 majors, 3 minors) — all addressed in cc59c4f0, re-review
  requested. Tests: tests/send-message-tool.test.ts (16). Gates: subagent 599 pass,
  core-runtime 409 pass, tsc ×3, biome, 26-pkg ext-entry typecheck green.
- Not done here (deliberate): persistence of follow-up exchanges as run records; TUI smoke.

## Goal

`send_message` tool: parent addresses a named agent (running → steer, idle → prompt)
by `name` or `agentId`; child-side `to:"main"` routes through the parent message bus.

## Steps

1. NEW `s2-agent-ext-subagent/src/send-message-tool.ts` — schema
   `{to, message, wait?, timeoutMs?}`; routing per spec §1 (unknown → error with live
   roster; wait via 250 ms poll idiom `subagent-runs-tool.ts:225-250`; no-wait
   completion notification through the BackgroundRunManager deliverer,
   `formatTaskNotification` reuse).
2. NEW `ParentMessageBus` (small module, core-runtime or subagent src) —
   process-singleton; extension entry wires its deliverer with
   `pi.sendMessage(..., {deliverAs:"followUp", triggerTurn:true})` next to
   `wireBackgroundDeliverer`.
3. `extensions/subagent.ts` — register the tool; wire the bus.
4. `src/index.ts` + barrel-surface expectations; read-only-safe set in
   `subagents-tool.ts` keeps `send_message` for read-only children.
5. `subagent-tool-schema.ts` doc cross-links (spawn with `name`; follow up with
   `send_message`).
6. CONTEXT.md terms: `send_message`, `named agent`, `live-agent registry`;
   `_Avoid_:` "resume" for anything but detach-manifest resume (now ambiguous —
   say *re-prompt*).

Depends on: ticket 01.

## Tests

- NEW `tests/send-message-tool.test.ts` — routing matrix (idle/running/unknown), wait
  timeout, main-broker delivery via fake deliverer, read-only child keeps the tool,
  steer-while-parent-waits (no deadlock).

## Acceptance

Package `bun run test` green; smoke: named agent completes → `send_message` follow-up
→ reply observed; message to a mid-flight agent steers.
