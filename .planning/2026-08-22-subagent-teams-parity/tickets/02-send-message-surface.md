# Ticket 02 — send-message-surface

status: open

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
