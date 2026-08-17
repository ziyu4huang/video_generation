# @repo/pi-agent-ext-webui

An embedded **loopback webui for the pi agent**: a small `Bun.serve` server that runs
IN-PROCESS with the agent (`.unref()`'d, so it never keeps the process alive), exposes a
browser frontend at `/` that co-drives the same `AgentSession` as the TUI, and streams
frames over a WebSocket. Rendered markdown/HTML views land in the browser, and HITL
presentations can be answered from there.

Architecture v2 (see `docs/architecture-v2.md`): the webui is now an **optional** render
+ interaction surface for the TUI agent — the browser is a PURE HITL companion (three
tabs: Inbox / Report / Data) — the TUI owns the conversation and tool logs, the webui
owns interaction: questionnaires, reports, and interactive data views, all behind the same agentic
mutex as the TUI. Security hardening
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

## webui v3 — pure HITL companion (three tabs)

The TUI owns the conversation and tool logs; the webui owns INTERACTION. v3 removed the
transcript scrollback and stopped subscribing the log frame family at the source.

- **Inbox** (boot default) — ask cards (questionnaire quick-pick; answers ride the
  ask-user bridge) + event cards, chronological; answered cards collapse into
  reviewable summaries. `#card-<id>` deep links activate the owning tab.
- **Report** — static reports: `report` frames render markdown via a DOM-built
  renderer, or sandboxed HTML (`iframe sandbox="allow-scripts"`, no same-origin).
  Producers (identical frames): the agent-side `webui_report` tool (in-process,
  no HTTP) and `POST /api/report {title, markdown|html, source?}` (external,
  loopback, origin-guarded); exactly one body mode, title 1–200 chars, 128KB
  cap; frames are replay-eligible (refresh-safe).
- **Data** — viewer cards (interactive HTML, sandboxed iframes).

Frame diet — web clients receive ONLY: `card`, `card_done`, `report`, `ask_user`,
`ask_user_done`, `session_info`, `error`, `mutex_blocked`, `mutex_force_release`,
`snapshot`, `appexec`, `view_opened`. TUI-only (never broadcast): `message_*`,
`tool_execution_*`, `tool_result`, `turn_*`, `agent_settled`, `session_*compact`.

### present adoption (2026-08-16)

- **Connected-gate**: zero connected clients ⇒ `webui_present` resolves
  `{skipped:"no_client"}` immediately — TUI-only sessions never deadlock. A mid-wait
  client disconnect auto-releases `{cancelled:true,reason:"no_client"}`.
- **Producers**: ANY extension may emit `webui:present` (archify does after render/delta,
  presenting Approve / Regenerate… controls); event-originated answers arrive as injected
  user turns — `[webui:present] "<title>": approved | tweak: "<text>"`.
- **ask-user mirror**: `rpiv:ask-user:prompt` → `ask_user` frame (replay-eligible) renders
  a dialog in the shell; answers ride the loose appexec channel back as
  `rpiv:ask-user:answer` — same `done` callback as the TUI dialog, first answer wins.

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

## Cards

The browser shell's **Cards tab** (`src/render-shell.ts` + the store-wrapped
broadcaster in `src/webui-wiring.ts`) is a chronological, replay-eligible card
stream — every `card` frame rides live fan-out AND the connect-time snapshot,
so a refresh restores the board exactly (including answered state, via the
ordered `card` → `card_done` replay).

- **Bus event stream** (readonly cards): every non-lifecycle bus event the
  webui does not already forward is projected as a `card` frame (kind
  `readonly`, attention `silent` — the snoop never bells) with a truncated
  JSON summary; raw objects never leak onto the wire.
- **Viewer cards** (kind `viewer`): producer-supplied raw HTML rendered ONLY
  inside a `sandbox="allow-scripts"` iframe srcdoc (NO `allow-same-origin` —
  opaque origin, no parent/same-origin access). The ONLY exit is the injected
  `webui.emit` postMessage bridge, gated host-side by a confirmation card
  whose Approve rides the generic answer loop.
- **Interactive cards** (kind `interactive`): fill-in form cards (question +
  labeled text/select fields, capped 8). Submit posts the `card_answer`
  appexec envelope; the wiring enforces FIRST-ANSWER-WINS, appends one JSONL
  decision-log line, and broadcasts the `card_done` tombstone that retires
  the form into an inert answered marker.
- **Questionnaire pilot** (event-cards 05): `rpiv:ask-user:prompt` ALSO
  broadcasts an interactive card (`ask-<promptId>`, attention `input`, fields
  mapped from the questionnaire). Its submit rides the EXISTING ask-user
  bridge — the `ask_user_answer` appexec envelope (same channel as the ask
  dialog; promptId = card id minus `ask-`), NOT `card_answer` — so ask answers
  are excluded from the cards decision log by design. The `card_done` tombstone
  rides `rpiv:ask-user:answered` (any questionnaire exit — TUI answer, browser
  card/dialog answer, or cancel retires the card).
- **archify pilot** (event-cards 05): `webui:open` (and the event-originated
  `webui:present` that follows) ALSO broadcasts a readonly card
  (`archify-<view>`, attention `view`) whose optional `body.url` deep link is
  the RESOLVED `/files` url — rendered as a `createElement` anchor
  (`target="_blank" rel="noopener"`). Same view → same card id, so an
  open+present pair replaces, never duplicates.
- **Attention bell + deep links**: non-silent cards ring `ui.notify` once with
  a `#card-<id>` deep link (see `cardBellMessage`); the shell routes the hash
  to the Cards tab and flashes the card (cold-load included).
- **Decision log**: answered generic/interactive cards append one line to
  `~/.pi/webui/sessions/<stamp>/cards.jsonl` (`{ts, cardId, answers}`) — the
  per-session audit trail. Ask-card answers are NOT logged there (the unify
  choice above: they are already attributable to the questionnaire).

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

- power-tool `webui` tool — single-call visual audit of the live shell (per-tab
  screenshots, card outline, console/page errors, design invariants).

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
