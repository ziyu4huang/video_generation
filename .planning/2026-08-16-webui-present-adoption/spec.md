# spec — webui-present-adoption

## Goal
Make the already-built HITL presentation loop actually used (archify wires it),
safe for TUI-only sessions (connected-gate), and convergent with core-task
ask-user (questionnaire mirrored into the browser shell).

## Decisions (source: map.md §Decisions, grilled 2026-08-16)
D1 all-of-three · D2 connected-gate · D3 free-text tweak · D4 ephemeral.

## Behavior contracts
### C1 Connected-gate (webui, ticket 01)
- `webui_present` (blocking tool) resolves immediately as
  `{skipped: "no_client"}` when zero webui clients are connected at call time —
  caller (LLM) falls back to `ui.notify`; no deadlock for TUI-only sessions.
- Mid-presentation client disconnect (clientCount 1→0): auto-release the pending
  presentation as `{cancelled: true, reason: "no_client"}`; the tool result
  tells the LLM to continue without approval.
- Connection signal source: WebServer clientCount (existing) — surfaced through
  wiring into present-tool's wait path; no new transport.

### C2 Producer wiring (archify + webui, ticket 02)
- archify `archify_render`/`archify_delta` success → emits `webui:present`
  EVENT (string-literal channel, same zero-import pattern as `webui:open`),
  payload: view/title (from meta, same fallbacks as webui:open) + controls
  `[{id:"approve",label:"Approve"},{id:"tweak",label:"Regenerate…",takesInput:true}]`.
- Event-originated presentations are fire-and-forget for archify (its tool
  result unchanged); the shell shows the toolbar via the existing handler.
- ANSWER ROUTING for event-originated presentations: webui injects a user turn
  via the host `sendUserMessage` path (existing, mutex-bypassing appexec →
  wiring) — `[webui:present] "<title>": approved` or `… tweak: "<text>"`. The
  orchestrating LLM sees it as user input and decides to regenerate or move on.
  (Tool-originated presentations keep the blocking tool-result path.)
- webui-optional: no webui handler / no client → event is a no-op for archify.

### C3 ask-user bridge (core-task ↔ webui, ticket 03)
- Mirror the ask-user questionnaire prompt event (verify exact name in
  `pi-agent-ext-core-task/src/ask-user/`, e.g. `rpiv:ask-user:prompt`) into a
  new replay-eligible WS frame `ask_user`; shell renders the questions as a
  dialog (select / multi-select / free text — reuse shell toast/panel styling).
- Browser answers route back through the appexec-respond envelope into the
  questionnaire SESSION (not as a user message) — the TUI dialog stays the
  other answering surface; first answer wins on multi-client.
- ZERO core-task imports of webui and vice versa (string-literal/event contract
  only). If core-task needs a tiny emit hook, it must be optional and inert
  when no listener exists.

## Non-goals
Structured tweak menus, variants/fork, region-select, decision persistence,
MLX producer wiring, multi-presentation queueing (one-pending guard stays).

## Gates
webui: typecheck + `bun test` 0 fail (baseline 463). archify: typecheck + tests
(1 known pre-existing env failure in vendored-bin-recovery). core-task: `bun
run check && bun test` per package gate.
