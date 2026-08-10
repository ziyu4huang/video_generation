# 04 — Web transport & protocol

type: prototype
blocked by: 01, 02
status: open

## Question

What is the web connection protocol — HTTP (static frontend assets) + WebSocket (event stream + commands) — including the `ExtensionEvent` union → WS frame mapping and the inbound command schema (prompt / steer / followUp / abort / app-exec)?

## Context (02 resolved — Bun.serve native WS + thin dispatch seam)

- **Transport**: `Bun.serve` with native WS (NOT node:http) on one loopback port — direct lift from `bun-apps/gui-movie-director/server.ts` (`Bun.serve` fetch+websocket, `serveWithFallback` port..port+50 on EADDRINUSE) and `api/ws.ts` (native WS client-set + `broadcastMessage` + subscribe). `.unref()` the server; one server per process (module singleton).
- **Outbound** (agent → web): map the events reachable via `pi.on(...)` (ticket 01) to WS frames — `message_*`, `tool_execution_start/update/end` (preserve `result.details`), `tool_result` (typed `.details`), `turn_*`, `agent_*`, `session_before_compact`/`session_compact`. `queue_update` is NOT reachable without a patch — decide if v1 needs it (map "Not yet specified": patches-gap scope; likely no for MVP).
- **Inbound** (web → agent): commands route through the dispatch seam; agentic commands (prompt/steer/followUp/abort) go through the `input`-event mutex (ticket 03) then map to `pi.sendUserMessage({deliverAs})` + `ctx.abort()`; app-exec commands bypass the mutex. Mirror btw's structured-input → submit → filtered-turn pattern.
- **Origin/auth**: lift `bun-apps/gui-movie-director/lib/origin.ts` `originAllowed` (DNS-rebinding-safe loopback Host-header guard) for both HTTP and the WS upgrade; add `randomUUID` token (from web-access) — see ticket 07.
- **Approval dialogs**: tools/extensions may request approval (`select`/`confirm`/`input`). Decide whether the web answers these in v1 or defers.
- Align with 05 (what `details` renderers consume), 06 (delivery), 07 (URL/port/auth).

## What resolving looks like

A typed schema (TypeBox/Zod) for both directions + a prototype WS handler wired to the session + mutex, forwarding `tool_execution_end.result.details` intact. The dispatch interface is the future-Path-B migration seam — keep it thin.
