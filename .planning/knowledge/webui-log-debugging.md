# Skill candidate: webui-log-debugging

**Candidate skill-name:** webui-log-debugging

**Trigger/symptom:** The pi agent TUI floods with repeated stderr lines like `[Bun.serve]: request timed out after 10 seconds` while the embedded webui (`bun-apps/pi-agent-ext-webui`) is running — often accompanied by the webui shell reconnecting its SSE `/api/events` stream every ~2s (each reconnect re-arms the 10s timer, so the flood never stops). The server is in-process and `.unref()`'d, so ANY `Bun.serve` stderr lands directly in the agent TUI.

**Lesson:** `Bun.serve` defaults to a **10s idle timeout**. Long-lived connections that sit silent — SSE `/api/events` streams waiting for the next render, idle WebSocket legs — get killed at 10s and Bun logs the timeout to stderr. For an embedded loopback server this is pure noise + reconnect churn. The shipped mitigations in `web-server.ts` `buildServeOptions()`: `idleTimeout: 0` at the serve level (kills the HTTP/SSE idle timeout and the stderr flood), `websocket.idleTimeout: 0` at the WS-handler level (Bun's WS default 120s idle would otherwise close an idle WS → `onWsClose` → `cancelAllPending` for a HITL presentation the user is still deciding on — a silent HITL gate must survive a user thinking for minutes), plus an SSE `: ping` comment heartbeat every 30s in `render-routes.ts` (`heartbeatMs`, injectable) so intermediate proxies also see liveness. Note: `ServerWebSocket` has NO per-socket timeout setter in `@types/bun` 1.3.14 — the handler-level `idleTimeout` option is the available seam.

**Proposed procedure:**
1. Repro/symptom-check: TUI shows the `[Bun.serve]: request timed out` flood while webui renders are idle.
2. Inspect the server's own log ring buffer: `curl -s http://127.0.0.1:<port>/api/logs | jq` — entries are `{ts, level, msg}`, newest-last, cap 200. Look for `webui listening on …`, `ws open (N live)` / `ws close (N live)` churn, `port N busy … walking` walk attempts, and `serve error: …` (uncaught fetch errors).
3. Verify the idle-timeout config is still in place: `buildServeOptions()` in `bun-apps/pi-agent-ext-webui/src/web-server.ts` must return `idleTimeout: 0` and `websocket.idleTimeout: 0` (covered by `tests/web-server.test.ts` → `WebServer buildServeOptions`).
4. Verify the SSE heartbeat: `render-routes.ts` `/api/events` must emit `: ping` every `heartbeatMs` (default 30s; covered by `tests/render-routes.test.ts` → heartbeat describe with an injected 20ms interval).
5. If the port is unknown, check the announce-on-first-render footer/notify (the wiring prints the live URL), or `WEBUI_PORT`/`PORT` env resolution (`port-resolver.ts`, `resolvePort`).

**Evidence:** PR fixing the TUI flood: `fix(webui): disable Bun.serve idle timeout (TUI flood) + SSE heartbeat + /api/logs ring buffer` (branch `fix-webui-idle-timeout`, base `c1dbb330`). The `/api/logs` route, `buildServeOptions()` refactor, and heartbeat landed in that commit with red→green TDD evidence in the package's test files.
