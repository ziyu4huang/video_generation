### Task 3 — Mutex glue + extension wiring (`extensions/webui.ts` + `notifier.ts`)

**Goal:** Wire everything together — the real `pi.on(...)` glue ticket 03 deliberately deferred. The factory constructs the `WebServer` (→ `Broadcaster`), constructs the `MutexController` wired to a `MutexNotifier` that pushes `mutex_blocked`/`mutex_force_release` frames through the broadcaster, and registers **every** `pi.on` handler. Inbound WS commands flow: `validateInbound → WebTransport.parseCommand → dispatch` (agentic → `handleInput("extension")` → op→pi-call; appexec → bypass; control → subscribe/unsubscribe). Block feedback is **broadcast**, not a per-command ack (spec §4 note supersedes ticket-03 §5). Governing spec: `specs/04-web-transport-protocol.md` §1 (Path-A lock: singleton + re-point + drop), §3 ("Wiring ownership" + "pi.on glue" + "MutexNotifier implementation"), §4 (broadcast-not-ack), §6 (no-session guard; appexec bypass; web-while-TUI → handled+broadcast).

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/notifier.ts`.
- Create: `bun-apps/pi-agent-ext-webui/extensions/webui.ts`.
- Create: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts`.
- Modify: `bun-apps/pi-agent/src/static-extensions.ts` (register STATICALLY — see Registration note; supersedes the original dynamic plan).

**TDD test list (RED first — name each):**
- `makeMutexNotifier routing`:
  - `notifyBlocked(blocked, by) -> mutex_blocked frame` (assert arg order: `("web","tui")` → `{type:"mutex_blocked", blocked:"web", by:"tui"}`)
  - `notifyForceRelease(driver) -> mutex_force_release frame`
  - `controller force-release routes through the notifier -> broadcaster` (FakeClock-style watchdog tick → `mutex_force_release` on the sink)
- `inbound dispatch (parseCommand -> handleInput -> descriptor)`:
  - `agentic idle -> gate continue -> agentic descriptor (source extension)`
  - `agentic while TUI driving -> handled + mutex_blocked broadcast (NOT per-command ack)`
  - `appexec descriptor is bypass (NOT routed through handleInput)` — assert `kind==="appexec"` and no `source` field (the branch precondition).
- `no-session-bound guard`: before the first `session_start` or after `session_shutdown` dropped the ref, an inbound command replies `{type:"error",reason:"no_session"}` and **never** dereferences null `pi`/`ctx`.
- `end-to-end smoke (real WebServer + fake pi/ctx)`:
  - `web agentic command while idle -> sendUserMessage called + gate continue`
  - `web agentic command while TUI driving -> swallowed (no sendUserMessage) + mutex_blocked broadcast`

**Implementation notes:**
- **`notifier.ts`** is tiny: `makeMutexNotifier(broadcaster): MutexNotifier` — `notifyBlocked(b,by)→broadcast({type:"mutex_blocked",blocked:b,by})`; `notifyForceRelease(d)→broadcast({type:"mutex_force_release",driver:d})`. Import `MutexNotifier` from `../src/mutex-controller.js` (the ticket-03 module — **consumed, not edited**).
- **`extensions/webui.ts`** is the canonical registered entry (CLAUDE.md: `extensions/<X>.ts`, one entry per package; here `webui.ts` since the folder is `pi-agent-ext-webui`). It default-exports an `ExtensionFactory`.
- **Module-level singleton** (spec §1): `let webServer: WebServer | null = null` at module scope. The module is cached → the singleton survives the per-session factory re-run. In the factory: `if (!webServer) { webServer = new WebServer({port:0}); webServer.start(); }` then **always** `webServer.bindSession(pi, ctx)` (re-point on every load = every `session_start`).
- **`pi.on("input")` is the mutex gate** (locked by ticket 02): `return controller.handleInput(ev.source).action === "handled" ? {action:"handled"} : {action:"continue"} as InputEventResult`. The handler returns synchronously before any await (the driver flag is set inside `gate`, JS single-threading = atomic).
- **Mutex lifecycle handlers:** `agent_settled → handleSettled`; `message_update` + `tool_execution_update → handleActivity`; `session_shutdown → handleShutdown + webServer.dropSession()`.
- **Outbound stream handlers** (spec §3): `message_start/update/end`, `tool_execution_start/end`, `tool_result`, `turn_start/end`, `agent_settled`, `session_before_compact`, `session_compact` → `broadcaster.broadcast(transport.mapEvent(ev))`. (`agent_settled` is forwarded AND drives `handleSettled` — register both.)
- **Inbound WS→dispatch** (the `onCommand` closure set via `webServer.setCommandHandler`): `validateInbound` already ran in `WebServer`; here `const action = transport.parseCommand(frame)`; branch:
  - `appexec` → return (bypass; v1 has no defined ops — spec §3 forward seam).
  - `control` → return (v1: WS client-set membership is the only state).
  - `agentic` → **guard session first** (`{type:"error",reason:"no_session"}` if null), then `controller.handleInput("extension")`; if `handled` → return (controller already broadcast `mutex_blocked`); if `continue` → resolve op→pi-call (spec §3 table): `prompt→pi.sendUserMessage(text)`; `steer→…({deliverAs:"steer"})`; `followUp→…({deliverAs:"followUp"})`; `abort→ctx.abort()`.
- **No-session guard** (spec §6): expose `webServer.hasSession()` (add to the Task 2 seam); the closure checks it first and replies `{type:"error",reason:"no_session"}` to the sending client (consistent with a generic error frame — NOT a bare `{type:"no_session"}`), **never** derefs null `pi`/`ctx`.
- **Registration (STATIC — supersedes the original dynamic plan):** register in `bun-apps/pi-agent/src/static-extensions.ts` (`STATIC_EXTENSION_FACTORIES`), NOT in `run-dir/manifest.json` `extensions[]`. Rationale: webui is an always-on EMBEDDED extension, and only a native static `import` is inlined by `bun build --compile` (a dynamic jiti `-e` path does not exist in the compiled `$bunfs` virtual FS — see the header comment in `static-extensions.ts`). One registration site only; do **NOT** also list in `manifest.json` `extensions[]` (double-register forbidden).

**Lift references (pattern, not code):**
- The persistent-co-frontend lifecycle is the **opposite** of `pi-agent-ext-web-access`'s `session_* → closeCurator()` (spec §2): webui **keeps** the server on `session_shutdown`, only drops the ref. web-access is the feasibility proof that an extension can host a listening server in-process; it is NOT the lifecycle template.
- The `pi.on` host-handler pattern (observe the **main** agent session via host `pi.on`, not a side session's `subscribe()`) is the webui analogue of btw's inbound-command schema — confirmed in spec §2.

**Seams:**
- Consumes: `mutex-controller.js` (MutexController + MutexNotifier, ticket 03), `notifier.js` (this task), `web-transport.js` (Task 1), `web-server.js` (Task 2), `protocol.js` (Task 0), and the pi SDK `ExtensionFactory`/`ExtensionAPI`/`ExtensionContext`/`InputEventResult` (**type-only**).

**Acceptance criteria:**
- `( cd bun-apps/pi-agent-ext-webui && bun test && bun run build )` green (incl. the unchanged ticket-03 mutex tests).
- `extensions/webui.ts` is the **only** file with a runtime `pi`/`ctx` dependency; `notifier.ts` has none beyond the broadcaster port.
- The static-registration entry is present in `bun-apps/pi-agent/src/static-extensions.ts` (`STATIC_EXTENSION_FACTORIES`), and `pi-agent-ext-webui` is NOT in `run-dir/manifest.json` `extensions[]` (one site only).
- Manual E2E (Step 8): the connect-test page streams frames; a `prompt` over WS injects a turn.
- `mlx_native.py` untouched; `mutex.ts`/`mutex-controller.ts` byte-identical to the ticket-03 merge.

**Pitfalls:**
- **Do NOT pre-gate inbound commands** with a second mutex check. The canonical gate is the `input` extension event (locked by ticket 02); a second gate site in the `onCommand` closure would diverge. The web learns its command was blocked via the `mutex_blocked` **broadcast** frame, not a synchronous ack (spec §4 note).
- **Do NOT route `appexec` through `handleInput`** — it would spuriously acquire the lock as `"web"` (spec §6). Branch on `action.kind === "agentic"` before gating.
- **`session_shutdown` ≠ `closeAll()`.** Drop the session ref + let that session's `pi.on` handlers go away; the **server stays** (persistent co-frontend).
- **Never deref null `pi`/`ctx`.** The no-session guard is mandatory between sessions.
- **One registration site only.** `static-extensions.ts` (`STATIC_EXTENSION_FACTORIES`) XOR `manifest.json` `extensions[]`. v1 uses STATIC (embedded/always-on → must survive `bun build --compile`).
- The `op → pi-call` switch must match spec §3 **exactly**: `prompt` (no `deliverAs`), `steer` (`deliverAs:"steer"`), `followUp` (`deliverAs:"followUp"`), `abort` (`ctx.abort()`). `sendUserMessage` is on `pi`; `abort` is on `ctx` (SDK verified).
- Register `agent_settled` for **both** `handleSettled` (mutex release) and `fwd` (outbound broadcast) — they are two distinct effects.
