# @repo/pi-agent-ext-webui

An embedded **loopback webui for the pi agent**: a small `Bun.serve` server that runs
IN-PROCESS with the agent (`.unref()`'d, so it never keeps the process alive), exposes a
browser frontend at `/` that co-drives the same `AgentSession` as the TUI, and streams
frames over a WebSocket. Rendered markdown/HTML views land in the browser, and HITL
presentations can be answered from there.

## Startup & URL discovery

- The server starts lazily on first use and **survives session shutdown** (persistent
  co-frontend; only the session ref is dropped/re-bound).
- The URL is announced **on first render** via the SDK `ui` surface (`ui.notify` +
  status line) — look for `webui ready — open http://127.0.0.1:<port> …` in the TUI.
- Port resolution (`src/port-resolver.ts`): `WEBUI_PORT` > `PORT` > `0`
  (OS-assigned ephemeral). If the requested port is busy, the server walks
  `port..port+50` before giving up.
- Loopback-only bind (`127.0.0.1`), with a DNS-rebinding-safe Host/Origin guard on
  every HTTP request and the WS upgrade; optional token auth (`?session=` /
  `body.token`) exists but the v1 loopback wiring runs with it off.

## Idle timeouts — why `0`

`Bun.serve` defaults to a **10s idle timeout**. Long-lived idle connections — the SSE
`/api/events` stream, the WS upgrade's HTTP leg — get killed at 10s, and Bun logs
`[Bun.serve]: request timed out after 10 seconds` to **stderr, which lands directly in
the agent TUI** (the server is in-process). With the shell reconnecting every ~2s this
became a permanent stderr flood.

`buildServeOptions()` (in `src/web-server.ts`) therefore sets:

- `idleTimeout: 0` — disables the serve-level idle timeout. Safe here: loopback-only,
  `.unref()`'d, no upstream LB/keep-alive policy to respect.
- `websocket.idleTimeout: 0` — Bun's WS default (120s idle) would close an idle WS →
  the close handler → `cancelAllPending` for a HITL presentation the user is still
  deciding on. A silent HITL gate must survive a user thinking for minutes.
  (`ServerWebSocket` has no per-socket timeout setter in `@types/bun` 1.3.14; the
  handler-level option is the available seam.)

## SSE heartbeat

`GET /api/events` (`src/render-routes.ts`) emits a `: ping` SSE comment frame every
30s (`heartbeatMs`, injectable via `createRenderRoutes(registry, { heartbeatMs })`) so
intermediate proxies also see liveness. Comment frames are ignored by `EventSource`
parsers — they never surface as a view update.

## Debugging

```bash
curl -s http://127.0.0.1:<port>/api/logs | jq
```

A bounded (200-entry) in-memory ring buffer, served **before** any installed routes
(it works even when none are). Entries are `{ ts, level, msg }`, newest-last:

- `webui listening on http://127.0.0.1:<port>` — server start
- `webui stopped (…)` — `stop()` (test teardown; NOT session shutdown)
- `ws open (N live)` / `ws close (N live)` — WS connect/disconnect with live client count
- `port N busy (…); walking to next port` — `serveWithFallback` port-walk attempts
- `serve error: …` — uncaught fetch errors (serve `error` callback)

The test gate for this package is **`bun test`** (the canonical `bun run test` =
`bun run build && bun test`); `typecheck` alone is not the gate.

The browser shell HTML is an embedded string in `src/render-shell.ts` (no separate
static file).
