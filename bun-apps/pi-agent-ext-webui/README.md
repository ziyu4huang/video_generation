# @repo/pi-agent-ext-webui

An embedded **loopback webui for the pi agent**: a small `Bun.serve` server that runs
IN-PROCESS with the agent (`.unref()`'d, so it never keeps the process alive), exposes a
browser frontend at `/` that co-drives the same `AgentSession` as the TUI, and streams
frames over a WebSocket. Rendered markdown/HTML views land in the browser, and HITL
presentations can be answered from there.

Architecture v2 (see `docs/architecture-v2.md`): the webui is now an **optional** render
+ interaction surface for the TUI agent — the browser mirrors the live agent stream
(transcript), accepts prompts + abort mid-turn, and answers HITL presentations (with a
Cancel button), all behind the same agentic mutex as the TUI. Security hardening
(loopback Host validation, sandboxed markdown/HTML rendering, symlink-safe `/output`,
header token auth) is documented there too.

## Optionality — the TUI can opt in/out

The webui is **on by default** (backward compatible). Disable or pin it three ways:

- **Env**: `WEBUI_DISABLED=1` (or `true`) disables the wiring entirely — no handlers, no
  tool, no server. `WEBUI_PORT=<n>` pins the port (else `PORT`, else OS-assigned).
- **pi-agent CLI** (TUI path): `bun bun-apps/pi-agent/src/cli.ts --no-webui` disables it;
  `--webui-port <n>` pins the port. The flags never reach pi's own parser.
- **Embedding hosts**: `wireWebui(pi, { enabled: false })` (and `{ port }`) — see
  `src/webui-config.ts` / `src/webui-wiring.ts`.

## What the browser can do (v2)

- **Live transcript mirror**: `message_update` deltas, tool calls/results, mutex signals,
  and turn/`settled` markers render into a scrollback; a connect-time `snapshot` frame
  replays session history on open/refresh (bounded, 500 frames).
- **Main-session interaction**: a prompt input (`{type:"prompt"}`, mutex-gated) and an
  Abort button (`{type:"abort"}`); outbound frames QUEUE while the WS reconnects so a
  HITL answer is never lost.
- **Rendered views**: tabs of named md/HTML views (`webui:render`), auto-focus on a
  presenting view, `![image](/output/0/…)` images. Producers can pass an `images`
  array on `webui:render` / `webui:present` — output paths are auto-converted to
  `![image](/output/0/<rel>)` markdown (the previously-unwired image-presentation
  helpers are now wired into the render/present path).
- **HITL**: `webui_present` presents declarative controls; the user answers (or **Cancel**s
  via the `appexec cancel` op) from the browser; the agent's `execute()` resolves with
  `{action, tweak?}` / `{cancelled:true}`.
- **btw side panel**: tangent thread, model/thinking switches (all 7 thinking levels now
  reach the wire).

## Full-fidelity HTML: `/files` route + `webui:open` event

Rendered views (`webui:render`) deliberately sandbox HTML with NO scripts. Some artifacts
— e.g. archify diagrams — are self-contained HTML whose product IS the inline JS runtime
(theme toggle, semantic nav, PNG/SVG/WebM export menu); stripping scripts would gut them.
Those are served instead by the dedicated **file route**, opened as a TOP-LEVEL browser tab
(not a shell view):

- **`GET /files/<rootIdx>/<rel…>`** (`src/file-routes.ts`) serves a full-fidelity file
  from the configured root allowlist. `.html` (case-insensitive) → `text/html;
  charset=utf-8` served inline; anything else → `application/octet-stream`. The leading
  `<rootIdx>` segment selects the root (REQUIRED — `/files/<rel>` without an index is a
  404).
- **Security posture**: every `/files` response carries
  `Content-Security-Policy: sandbox allow-scripts allow-downloads` (opaque origin — the
  document can never reach `/api` or the WS endpoint same-origin) + `X-Content-Type-Options:
  nosniff`. Containment mirrors `/output`: decode-after-strip, NUL reject, `realpathSync`
  both sides, trailing-separator prefix rule, regular files only — every failure
  (traversal, symlink hop, escape, directory, missing file, bad index) is the SAME uniform
  404 that never leaks existence.
- **Fail closed**: an empty root allowlist (the default) serves nothing but uniform 404s.
- `GET /files` exact and non-GET `/files` requests fall through to the WebServer's default
  404 (no CSP header) — the `/output` convention; those paths can never serve `/files`
  bytes.

**`webui:open` event** (`src/open-event-handler.ts`) — ANY extension may emit it on the
shared `pi.events` bus with `{ path, view?, title? }`:

- `path` (required): absolute or cwd-relative path to the file. Validated against the SAME
  root allowlist + containment core as the route (they can never disagree about what is
  servable); outside-roots/malformed payloads are ignored (never throw — bus robustness).
- On success the handler announces a clickable `${title ?? path} — open <url>` via
  `ui.notify`; `rel` is percent-encoded per segment so filenames with spaces/`#` round-trip.
  No shell tab is created — the URL opens a top-level browser document.
- Config (`src/webui-config.ts` → `resolveFileRoots`): wiring `fileRoots` (e.g.
  `wireWebui(pi, { fileRoots: ["/abs/dir"] })`) > env `WEBUI_FILE_ROOTS`
  (`:`-separated; relative entries resolve vs cwd; duplicates dedupe, first-match-wins) >
  default none.
- Cross-package example: `pi-agent-ext-archify` emits `webui:open` after every successful
  `archify_render` / `archify_delta` (see its README) — webui imports nothing from archify
  and vice versa; the string-literal channel is the whole contract.

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

The test gate for this package is **`bun test`** (the canonical `bun run test`; src-entry
package — no build step); `typecheck` alone is not the gate.

The browser shell HTML is an embedded string in `src/render-shell.ts` (no separate
static file).
