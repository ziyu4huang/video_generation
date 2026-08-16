# webui-event-cards — Spec

## Problem

The webui duplicates the TUI chat surface with a worse composer (mutex-gated
placeholder, IME edge cases, layout pressure at the bottom of the transcript).
Meanwhile the things only a browser does well — rich read-only views,
fill-in forms, sandboxed HTML viewers — have no first-class home.

## Direction (user-approved 2026-08-16)

1. **De-chat**: remove the main composer from the webui. Chat is the TUI's job.
   The webui keeps the btw sidebar (web-native side-channel question) with IME
   fixed, and becomes the client-end interactive surface.
2. **Event cards**: one primitive, three roles:
   - `readonly` — bus-event stream projected into the Cards tab
   - `interactive` — fill + send back (questionnaires, Approve/Tweak)
   - `viewer` — sandboxed HTML views
3. **Attention**: `view | input | silent` per card; non-silent cards raise a TUI
   notify bell with deep link `#card-<id>`.
4. **Decision log**: interactive-card answers append to `sessions/<id>/cards.jsonl`.
5. **Sandbox bridge**: viewer cards may emit via `webui.emit` postMessage —
   every emit crosses a user-confirmation gate (confirm card) before reaching
   the bus. Never un-gated.
6. **Progressive bridging**: existing surfaces (views panel, ask dialog, present
   toolbar) stay untouched; the Cards tab projects the same frames.

## Frame contract

Server → client (replay-eligible, store-wrapped broadcaster):

    { type: "card", id: string,
      kind: "readonly" | "interactive" | "viewer",
      title: string, source: string, ts: number,
      attention: "view" | "input" | "silent",
      body: unknown }   // shape per kind, defined per ticket

Client → server card answers ride the EXISTING loose appexec channel:
`extra.kind: "card_answer"` guarded at `onCommand` TOP (ahead of
`parseCommand`) — the proven ask_user_answer pattern. No new inbound schema
member.

## Bus snoop (readonly source)

Wrap `pi.events.emit` once at wiring time; forward events NOT in
OUTBOUND_EVENTS (the 12 replayed events: message_start/update/end,
tool_execution_*, tool_result, turn_*, agent_settled, session_*compact) as
`readonly` cards with `attention: "silent"` — replayed snapshots must not
re-bell or re-log (flood guard).

## v1 pilot

Questionnaire cards (interactive) + archify cards (readonly/viewer). Producers
opt in per ticket 05; the frame contract stays generic.

## Non-goals

- No replacement chat surface; no composer work beyond removal.
- No structured present menus (settled in present-adoption: free-text tweak).
- No un-gated sandbox → bus emissions.

## Decisions

- D1 progressive bridging over replacing existing panels.
- D2 user-confirmation gate for ALL sandbox emits.
- D3 JSONL decision log for interactive answers only (not readonly views).
- D4 v1 pilot = questionnaire + archify.
- D5 de-chat first (ticket 00) — remove the broken surface before adding.
