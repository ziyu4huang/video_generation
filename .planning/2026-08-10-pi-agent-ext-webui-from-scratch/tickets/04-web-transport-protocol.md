# 04 — Web transport & protocol

type: prototype
blocked by: 01, 02
status: open

## Question

What is the **web connection protocol** — HTTP (static frontend assets) + WebSocket (event stream + commands) — including the `AgentSessionEvent`/`ExtensionEvent` union → WS message mapping and the inbound command schema (prompt / steer / followUp / abort / app-exec)?

## Context

- Server side (path A, per 02): the extension's `Bun.serve` serves the built frontend over HTTP and speaks WS; `.unref()` it, stop on `session_shutdown`.
- **Outbound**: map the events reachable via `pi.on(...)` (ticket 01) to WS frames — `message_*`, `tool_execution_start/update/end` (preserve `result.details`), `tool_result` (typed `.details`), `turn_*`, `agent_*`, `session_before_compact`/`session_compact`. **`queue_update` is NOT reachable without a patch** — decide if v1 needs it (see map "Not yet specified": patches-gap scope; likely no for minimal MVP).
- **Inbound**: agentic commands (prompt/steer/followUp/abort) MUST route through the agentic mutex (03); app-exec commands bypass it. Map inbound to `pi.sendUserMessage({deliverAs})` + `ctx.abort()`.
- **Approval dialogs**: tools/extensions may request approval (`select`/`confirm`/`input` via the RPC extension-UI sub-protocol, or `ExtensionUIContext`). Decide whether the web answers these in v1 or defers.
- Align with 05 (what `details` the renderers consume) and 06 (delivery) and 07 (URL/port).

## What resolving looks like

A typed schema (TypeBox or Zod) for both directions + a prototype WS handler wired to the session + mutex, forwarding `tool_execution_end.result.details` intact.
