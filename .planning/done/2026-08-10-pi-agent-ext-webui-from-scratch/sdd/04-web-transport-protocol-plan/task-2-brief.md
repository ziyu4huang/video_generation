### Task 2 — `Broadcaster` port + `WebServer` adapter (the volatile transport)

**Goal:** Build the injected broadcaster port and the `Bun.serve` adapter that is the **only** transport touch-point. The adapter owns HTTP (`/health` + a stub connect-test page + `/ws` upgrade), the WS client-set + broadcast fan-out, the shared origin guard, the inline port-walk, `.unref()` (webui is embedded), and the module-level singleton lifecycle (lazy start, re-point `pi`/`ctx` per `session_start`, drop ref on `session_shutdown` — server **survives**). Governing spec: `specs/04-web-transport-protocol.md` §2 (ground-truth lift map), §3 (`Broadcaster` port + `WebServer` adapter + lifecycle), §5 (origin-only auth; minimal stub page), §6 (failure modes: non-loopback 403/denied, malformed ignored, EADDRINUSE throw, shutdown ≠ closeAll).

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/broadcaster.ts`.
- Create: `bun-apps/pi-agent-ext-webui/src/web-server.ts`.
- Create: `bun-apps/pi-agent-ext-webui/tests/broadcaster.test.ts`.
- Create: `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts`.

**TDD test list (RED first — name each):**
- `MemoryBroadcaster`:
  - `captures broadcast frames in order`
  - `mutex frames are captured with payload`
- `WebServer origin guard`:
  - `HTTP: non-loopback Origin -> 403`
  - `HTTP: absent Origin -> allowed (200 "ok")`
  - (WS-upgrade-denied for non-loopback Origin is covered by the integration test below; add an explicit one if cheap.)
- `WebServer singleton lifecycle`:
  - `start is idempotent (second start is a no-op, same url)`
  - `bindSession / dropSession swap the live session ref without restarting` (url unchanged)
  - `unrefs the server so it does not keep the process alive` (`unrefed === true`)
- `WebServer broadcast over a real WS` (integration):
  - `delivers a broadcast frame to a connected client` — open a real `WebSocket` to the started `Bun.serve` on port 0, call `server.broadcast({type:"turn_start"})`, assert the frame arrives on `ws.onmessage`.

**Implementation notes — what to LIFT (verified against `origin/main`):**
- **`Bun.serve` shape** ← `gui-movie-director/server.ts` `serverConfig` (`fetch` + `websocket` + `static "/health"`). webui inlines `/health` in `fetch` instead of `static`.
- **WS client-set + broadcast** ← `gui-movie-director/api/ws.ts`: `connectedClients: Set<ServerWebSocket>`, `open`/`message`/`close` handlers, `broadcastMessage(data)` fan-out with per-ws `try/catch`.
- **`originAllowed(origin, host)`** ← `gui-movie-director/lib/origin.ts`: fixed allowlist `[127.0.0.1, localhost, [::1]]` over the **Host-header port** (DNS-rebinding-safe); absent `Origin` allowed; non-loopback denied. **Share it identically on HTTP fetch AND the WS upgrade** (spec §2). Copy it inline into `web-server.ts` (it is short; do not create a cross-package lib).
- **`serveWithFallback(cfg)`** ← `gui-movie-director/server.ts:65`: walk `port..port+50` on `EADDRINUSE`, throw "exhausted port range". **It is NOT a lib export — copy it inline.** Do NOT add an import of `gui-movie-director` (that would couple a prototype extension to a sibling app).

**Implementation notes — what to CHANGE vs the lift sources:**
- **ADD `.unref()`.** `gui-movie-director` is a foreground dev server and calls NO `.unref()`. webui is **embedded in the agent process**; the server must not keep the process alive on its own (spec §2, §3). Call `server.unref()` right after `serveWithFallback`.
- **Module-level singleton lifecycle** — NOT a `globalThis._devServer` hot-reload cache (that is gui-movie-director's concern). webui wants: `start()` idempotent; `bindSession(pi, ctx)` re-points a mutable `session` ref; `dropSession()` nulls it; **the server stays** across `session_shutdown` (persistent co-frontend — NOT `closeAll()`, NOT `server.stop()`).
- **No `subprocessManager` / job-subscribe / replay-buffer logic** from `api/ws.ts` — webui's `message` handler only validates the frame and hands it to an injected `onCommand` callback (the seam to Task 3). v1 has NO replay buffer (spec §9).
- **Stub connect-test page** ← inline string (spec §5): `/health` + a tiny page that opens the WS and `console.log`s received frames. Just enough to validate E2E manually (Task 3 Step 8). The real frontend is ticket 06.

**Seams:**
- Consumes: `protocol.js` (`validateInbound`, `ClientFrame`, `WebFrame`), `broadcaster.js` (`Broadcaster`).
- Produces: `WebServer implements Broadcaster` → Task 3 constructs it (module singleton), calls `bindSession`/`dropSession`, and `setCommandHandler(closure)` where the closure runs `WebTransport.parseCommand` + dispatch.
- **The `onCommand` callback is the ONLY inbound seam.** `WebServer` must NOT import `web-transport` (keep the adapter volatile). The no-session guard (`no_session` reply) lives in Task 3's closure, NOT in `WebServer` — expose `hasSession()` (or let the closure read `webServer`) so the closure can guard.

**Acceptance criteria:**
- `( cd bun-apps/pi-agent-ext-webui && bun test tests/broadcaster.test.ts tests/web-server.test.ts )` green, incl. the real-WS integration test.
- `( cd bun-apps/pi-agent-ext-webui && bun run build )` exits 0.
- `grep -n "web-transport" src/web-server.ts` returns nothing (adapter is protocol-free).
- Non-loopback Origin → 403 on HTTP and upgrade-denied on WS; absent Origin → allowed (both sites).

**Pitfalls:**
- **`serveWithFallback` MUST be copied, not imported** (spec §2: it is inline in `gui-movie-director/server.ts`, not exported). Importing from the sibling app couples a prototype extension to it.
- **`.unref()` is required.** Forgetting it keeps the agent process alive after the session ends. The lifecycle test asserts `unrefed === true`.
- **Do NOT `server.stop()` on `session_shutdown`.** The server survives; only the session ref is dropped. `session_shutdown` ≠ `closeAll()` (spec §6).
- **Do NOT route inbound commands to the controller from here.** `WebServer` is transport-only; the dispatch decision is Task 3's `onCommand` closure.
- **Malformed frames are ignored, never crash, never acquire the lock** (spec §6) — `validateInbound` returns null → `onMessage` returns.
- Bind on `127.0.0.1` (loopback-only, spec §5). The origin guard is the second layer of defense, not the only one.
- Port `0` in tests (ephemeral) to avoid CI flakiness; the prod factory also binds `0` (v1 does not implement worktree port-discovery — that is gui-movie-director's concern; webui's actual port is discoverable via the connect-test page URL / a future `gui:port`-equivalent).
