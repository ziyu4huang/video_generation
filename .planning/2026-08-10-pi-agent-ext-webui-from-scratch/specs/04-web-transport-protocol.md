# 04 — Web transport & protocol

- **Effort:** `2026-08-10-pi-agent-ext-webui-from-scratch`
- **Ticket:** `tickets/04-web-transport-protocol.md` (type: prototype; blocked-by 01 ✅, 02 ✅; 03 ✅ merged — PR #1223 `0d45e93c` — provides the mutex seam this spec wires)
- **Status:** draft (SPEC phase)
- **Ground truth verified against:** `@earendil-works/pi-coding-agent` v0.84.1; `origin/main @ b9f1ca08` (superset of the pre-merge `4b1d78e6`; includes the ticket-03 code merge `0d45e93c`)

## 1. Goal & scope

Define the **wire protocol** between the in-process pi extension and a co-frontend web client — **HTTP** (static assets + a minimal stub page) and **WebSocket** (bidirectional: outbound `ExtensionEvent` → WS-frame mapping agent → web; inbound command schema web → agent that routes agentic commands **through** the ticket-03 mutex and **bypasses** the lock for pure app-exec). The transport is a **deep module** sitting behind an injected **broadcaster port** — a stable interface wrapped around a volatile transport, and the future Path-B migration seam. To the user this surface is the "working…" mutual-exclusion experience: when one side is driving a model turn, the other is hard-rejected and shown "working…".

**Locked by ticket 02 (do not re-litigate):**

- **Path A** = in-process `Bun.serve` + native WS + loopback + a `.unref()`-able **module-level singleton** that survives session switches (the extension factory re-runs per session, the module is cached → the server persists); on each `session_start` it re-points its `pi`/`ctx` to the live session.
- A **thin dispatch seam** for future Path-B migration (later re-pointable at `PiServerService`/`PiSessionRuntime` without rewriting the web client).

**Locked by ticket 03 (do not re-litigate):**

- The lock **is** `AgentMutex` + `MutexController`. webui only **routes** inbound agentic commands **through** `MutexController.handleInput(source)`; **app-exec bypasses** the controller entirely.
- webui **supplies the `MutexNotifier`** — the callbacks that turn `notifyBlocked` / `notifyForceRelease` into outbound WS frames (`mutex_blocked` / `mutex_force_release`).
- The real `pi.on(...)` wiring (the glue ticket 03 deliberately left to this ticket) lives here, not in `mutex.ts`.

**Locked by ticket 01 (do not re-litigate):**

- Reachable `pi.on` event set: `message_{start,update,end}`, `tool_execution_{start,update,end}`, `tool_result` (typed `.details`), `turn_{start,end}`, `agent_settled`, `session_before_compact`, `session_compact`; the `input` event carries `source` (`interactive` | `extension` | `rpc`) and returns `InputEventResult { action: continue | handled | transform }`.
- `sendUserMessage(text, { deliverAs: "steer" | "followUp" })` injects a turn (works mid-stream); `ctx.abort()` aborts.

**This spec decides:** the frame schema (both directions); the `WebTransport` deep-module shape + the injected **broadcaster port**; the mutex-glue `pi.on` wiring; the v1 origin/auth model; the HTTP stub surface; the approval-dialogs scope (deferred); and the validation stance (spec → plan → SDD/TDD, no throwaway).

## 2. Ground truth (verified, pi v0.84.1, origin/main @ b9f1ca08)

| Claim | Status | Evidence |
|---|---|---|
| `Bun.serve` = native HTTP + WS on one object, unref-able | ✅ | `gui-movie-director/server.ts` (`Bun.serve` fetch + websocket). NOTE: gui-movie-director calls **no** `.unref()` (it is a foreground dev server); webui **must** add `.unref()` because it is embedded in the agent process. |
| `serveWithFallback` port-walk (`port..port+50` on `EADDRINUSE`) | ✅ | `gui-movie-director/server.ts:65` (`function serveWithFallback`), throws at `:75` ("exhausted port range"). It is **inline, not a lib export** → webui copies it in. |
| WS framing = JSON text frames with a `{type}` discriminator | ✅ | `gui-movie-director/api/ws.ts` (`wsHandlers` `{open,message,close}`, `connectedClients` `Set`, `broadcastMessage`). |
| `originAllowed(origin, host)` — DNS-rebinding-safe loopback Host-header guard: fixed allowlist `[127.0.0.1, localhost, [::1]]` over the Host-header port; absent `Origin` allowed; shared identically on HTTP fetch + WS upgrade | ✅ | `gui-movie-director/lib/origin.ts:25`. |
| Port discovery = FNV-1a per-worktree (`3099 + hash%900`) + pid-liveness-pruned shared registry via git common-dir | ✅ | `gui-movie-director/lib/worktree.ts` (`PRIMARY_PORT = 3099`, `PORT_RANGE = 900`, `hash32` FNV-1a), `lib/gui-registry.ts`. |
| Reachable `pi.on` events (ticket-01 verified; pi SDK types confirm): **outbound-stream events** — `message_{start,update,end}`, `tool_execution_{start,update,end}`, `tool_result` (typed `.details`), `turn_{start,end}`, `agent_settled`, `session_before_compact`, `session_compact`; **lifecycle events** — `session_start`, `session_shutdown`. The `input` event carries `source` (`interactive` | `extension` | `rpc`) and returns `InputEventResult { action: continue | handled | transform }` | ✅ | ticket-01 verified (map.md "Architecture ground truth"). |
| `sendUserMessage(text, {deliverAs:"steer"|"followUp"})` injects a turn (works mid-stream); `ctx.abort()` aborts | ✅ | ticket-01 verified. |
| **NOT** reachable without a source patch: full `messages` snapshot, `isStreaming`, `isCompacting`, live `queue_update` deltas (`queue_update` is only on `session.subscribe()`, absent from the `ExtensionEvent` union) | ✅ | ticket-01 verified. |
| Ticket-03 mutex API: `MutexController.handleInput(source) → { action: "continue" | "handled" }` (identity mapping); `MutexNotifier { notifyBlocked(blocked, by), notifyForceRelease(driver) }`; plus `handleSettled` / `handleActivity` / `handleShutdown`. Import path: `@repo/pi-agent-ext-webui/src/mutex-controller.js` | ✅ | `bun-apps/pi-agent-ext-webui/src/mutex-controller.ts:53,64,69,74` (`handleInput`/`handleSettled`/`handleActivity`/`handleShutdown`); `MutexNotifier` at `:22` (`notifyBlocked(blocked: Frontend, by: Frontend)`, `notifyForceRelease(driver: Frontend)`). Package `@repo/pi-agent-ext-webui` (`package.json`). |
| btw gets live tool/turn status via its **side** sub-session's `AgentSession.subscribe()`, **NOT** host `pi.on` — BUT webui observes the **MAIN** agent session, whose events **do** arrive via host `pi.on` (the row above) | ✅ | `bun-apps/pi-agent-ext-btw/src/btw/session.ts:327` (`session.subscribe(...)` on the side session); the distinction is btw's *own* side session vs the main agent — webui observes the main agent, so host `pi.on` is correct. |
| web-access server primitives (`node:http` `listen(0,"127.0.0.1")`, `randomUUID` token, `pi.exec("open")`, idle/stale watchdog, `session_* → closeCurator()` — closes all active curator servers) are a **PATTERN reference only** — webui is a **persistent co-frontend**, so it does **NOT** tear its server down on `session_shutdown` (it only drops the session ref) | ✅ | `pi-agent-ext-web-access/curator-server.ts:600` (`listen(0,"127.0.0.1")`), `:609` (`watchdog = setInterval(...)`), `:9`/`:624` (`STALE_THRESHOLD_MS`); `index.ts:34` (`randomUUID`), `index.ts:369` (`closeCurator`), `index.ts:1242-1245` (`session_shutdown → closeCurator`). |

**Implication:** the protocol is a thin mapping over an already-verified event surface + proven transport primitives; **v1 needs no new pi patches**.

## 3. Design — deep module + adapters

Three collaborating pieces: a pure deep module (`WebTransport`), an injected port (`Broadcaster`), and a volatile adapter (`WebServer`). This separation is the Path-B migration seam.

### `WebTransport` — the deep module

Pure dispatch + frame mapping. **No I/O, no `Bun` import, no runtime pi dependency** — `ExtensionEvent` is a type-only / structural reference that erases at compile time, so the module stays I/O-free and fully testable in isolation. It takes the ticket-03 `MutexController` and a small command/abort surface as injected dependencies and exposes a tiny interface over a large behavior (the whole protocol + mutex routing).

```typescript
/** A frame shaped for the broadcaster port (the seam). */
type WebFrame = { type: string; [k: string]: unknown };

/** Inbound client command, as parsed from the WS text frame. */
type ClientFrame = { type: string; text?: string; [k: string]: unknown };

/** What `parseCommand` resolves an inbound frame to. */
type DispatchAction =
  | { kind: "agentic"; op: "prompt" | "steer" | "followUp" | "abort"; text?: string }
  | { kind: "appexec"; op: string /* bypasses the mutex */; [k: string]: unknown }
  | { kind: "control"; op: "subscribe" | "unsubscribe" };

interface WebTransport {
  /** Inbound: parse + route. agentic → MutexController.handleInput("extension");
   *  on action "continue" → emit sendUserMessage({deliverAs}) / ctx.abort();
   *  on action "handled" → swallow (the controller already fired notifyBlocked).
   *  appexec → bypass the controller entirely. control → subscribe/unsubscribe. */
  parseCommand(frame: ClientFrame): DispatchAction;
  /** Outbound: map a host ExtensionEvent to a WebFrame, forwarding `.details` intact. */
  mapEvent(event: ExtensionEvent): WebFrame;
}
```

- **op → pi call (the 4 agentic ops):**
  - `prompt` → `pi.sendUserMessage(text)`
  - `steer` → `pi.sendUserMessage(text, { deliverAs: "steer" })`
  - `followUp` → `pi.sendUserMessage(text, { deliverAs: "followUp" })`
  - `abort` → `ctx.abort()`
- **`appexec` is a forward seam, not a v1 feature:** v1 defines NO concrete `appexec` ops — `{type:"appexec"}` is a forward-looking routing seam (the bypass-mutex path), parallel to the Path-B seam, to be filled by a later ticket. v1 `parseCommand` accepts and routes `appexec` frames through the bypass, but there are no defined ops or executors yet.

- **Depth check (deletion test):** delete `WebTransport` and the extension re-implements the frame `{type}` table twice (outbound + inbound), the agentic-vs-appexec-vs-control routing, the `handleInput` → `sendUserMessage`/`abort` translation, and the mutex-action swallows — all at the call site, tangled with I/O. The module earns its keep.

### `Broadcaster` — the injected port

A stable one-method port around a volatile transport; the real Path-B swap point.

```typescript
interface Broadcaster {
  /** Fire-and-forget fan-out of one outbound frame to all web clients. */
  broadcast(frame: WebFrame): void;
}
```

- **Real adapter (v1):** gui-movie-director-style WS client-set broadcast (`api/ws.ts` `broadcastMessage` over `connectedClients`).
- **Test adapter:** an in-memory sink that captures frames for assertions.

Two adapters ⇒ a real seam ⇒ the **Path-B migration point**: later swap the WS adapter for a `PiServerService` lease without touching `WebTransport` or the web client.

### `WebServer` — the volatile adapter

The **only** `Bun.serve` touch-point. Owns: `fetch` (HTTP: `/health` + the stub page + `/ws` upgrade), the `websocket` handlers (`wsHandlers`), `serveWithFallback`, `.unref()`, and the module-level singleton lifecycle (lazy start on first `session_start`, re-point on each subsequent `session_start`, drop the session ref on `session_shutdown` — server survives).

### `MutexNotifier` implementation

webui's notifier turns controller callbacks into outbound frames through the broadcaster:

- `notifyBlocked(blocked, by)` → `broadcaster.broadcast({ type: "mutex_blocked", blocked, by })`
- `notifyForceRelease(driver)` → `broadcaster.broadcast({ type: "mutex_force_release", driver })`

### `pi.on` glue (the real wiring ticket 03 deferred)

This is the host wiring the controller was designed for. Registered once per session in the factory:

- **Inbound mutex:** `pi.on("input")` → `controller.handleInput(source)` → `return { action } as InputEventResult`. (On `handled`, the controller already called `notifyBlocked`; the handler just returns `handled`.)
- **Mutex lifecycle:** `pi.on("agent_settled")` → `handleSettled`; `pi.on("message_update" | "tool_execution_update")` → `handleActivity`; `pi.on("session_shutdown")` → `handleShutdown`.
- **Outbound stream:** `pi.on(message_* | tool_execution_* | tool_result | turn_* | agent_settled | session_*)` → `WebTransport.mapEvent` → `broadcaster.broadcast`.

### Wiring ownership

- The **extension entry** (`extensions/webui.ts` factory) owns: constructing the `WebServer` (which exposes the `Broadcaster` over its WS client-set), constructing the `MutexController` wired to a notifier that pushes through the broadcaster, and registering **every** `pi.on(...)` handler.
- `WebServer` **implements `Broadcaster`** (it holds `connectedClients` + `broadcastMessage`, lifted from `gui-movie-director`'s `api/ws.ts`).
- `WebTransport` is pure (no I/O, no runtime pi dependency) — it only maps/parses; the extension entry calls into it from the `pi.on` handlers.

This closes the ambiguity about who owns the `pi.on` registrations and the broadcaster.

## 4. Wire schema (decision-encoding type shapes)

Both directions are JSON text frames with a `{type}` discriminator. The shapes below encode the decisions; exact TypeBox schemas are pinned in the plan.

### Outbound frames (server → client)

```typescript
type OutboundFrame =
  // agent stream (forwarded from pi.on, .details passed through intact)
  | { type: "message_start" | "message_update" | "message_end" }
  | { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"; toolName: string /* + …details */ }
  | { type: "tool_result" /* …details */ }
  | { type: "turn_start" | "turn_end" }
  | { type: "agent_settled" }
  | { type: "session_before_compact" | "session_compact" }
  // mutex signals (from the MutexNotifier impl)
  | { type: "mutex_blocked"; blocked: "web" | "tui"; by: "tui" | "web" }
  | { type: "mutex_force_release"; driver: "web" | "tui" };
```

### Inbound commands (client → server)

```typescript
type InboundFrame =
  // agentic — routed THROUGH MutexController.handleInput("extension")
  | { type: "prompt" | "steer" | "followUp"; text: string }
  | { type: "abort" }                                 // agentic — ctx.abort()
  | { type: "appexec" /* bypass mutex */ }            // pure app-logic; v1 = forward seam, no defined ops (see §3)
  | { type: "subscribe" | "unsubscribe" };            // control
```

> **Block feedback is broadcast, not per-command ack (v1).** The canonical mutex gate is the `input` extension event (locked by ticket 02). webui does NOT pre-gate inbound commands (a second gate site would diverge from the locked decision), so the web learns its command was blocked via the `mutex_blocked` broadcast frame (produced by `MutexNotifier.notifyBlocked`), not a synchronous per-command response. **This supersedes ticket-03 §5's** speculative per-command `{ ok, blocked, by, message }` response — that design predated this transport spec; ticket 04 now owns transport semantics. **UX implication (ticket 06):** the web client must retain the user's submitted text locally until it observes either a turn starting (`message_start` / `tool_execution_start`) or a `mutex_blocked` frame, and re-present the text on block. A per-command ack with request-id correlation is a documented future enhancement.

- **Validation lib: TypeBox.** STEP-2 evidence: `@sinclair/typebox` / `TypeBox` appears across the pi ecosystem — `pi-agent` (e.g. `src/doctor.ts`, `scripts/lib/build-extensions.ts`, `run-dir/resolve.ts`), `pi-agent-cli` (`src/commands/schema-cost.ts`, `tools-metrics.ts`), and sibling extensions `pi-agent-ext-{movie-director,knowledge-card,workflow,zai-mcp}` — while a repo-wide grep for `zod` (`from "zod"` / `\bzod\b`) returns **zero** `.ts` files. webui matches the ecosystem standard; the exact TypeBox schemas are confirmed in the plan.

## 5. v1 scope decisions (user-approved frontier)

- **Approval dialogs** (`select` / `confirm` / `input`): **deferred** to a later ticket. v1 = drive / observe / abort only.
- **Auth:** origin-loopback **only** — lift `originAllowed`, shared on HTTP + WS. The `randomUUID` bearer token is **deferred to ticket 07**.
- **HTTP surface:** a **minimal stub page** — `/health` + a tiny connect-test page that opens the WS and prints received frames, enough to validate the protocol end-to-end. The real frontend is ticket 06.
- **Validation:** straight to **spec → plan → SDD/TDD**; no separate throwaway prototype (the seams are pre-validated by prior art — gui-movie-director, web-access, btw — matching the ticket-03 precedent).

## 6. Failure modes / edge cases

| Situation | Behavior |
|---|---|
| WS disconnect mid-turn | Client reconnects; broadcast is fire-and-forget. Mutex state + watchdog unaffected. v1 accepts the missed-frame gap — **no replay buffer** (see §9). |
| Non-loopback `Origin` | HTTP `403`; WS upgrade **denied**. (`originAllowed`, shared HTTP + WS.) |
| Malformed inbound frame | Ignored (+ optional error frame). **Never** crashes, **never** spuriously acquires the lock. |
| Inbound command while no session is bound | Before the first `session_start`, or after `session_shutdown` dropped the ref: reply with an error / `no_session` frame; **NEVER** dereference a null `pi`/`ctx` ref. The server stays up (persistent co-frontend); it simply has no session to drive until the next `session_start`. |
| Web agentic cmd while TUI driving | `handleInput("extension")` → `{ action: "handled" }` → swallow + `notifyBlocked` → `mutex_blocked` **broadcast** frame to web (broadcast-only, no per-command ack — see the §4 note above). |
| `appexec` cmd | **Must NOT** be routed through `handleInput` (else it risks a spurious acquire as `"web"`). Bypass the controller. |
| Bind failure `EADDRINUSE` ×51 | `serveWithFallback` throws; webui is unavailable for that session; **TUI unaffected**. |
| `session_shutdown` | Drop the session ref + unsubscribe that session's outbound handlers; the **server survives** (persistent co-frontend) — **NOT** `closeAll()`. |
| Watchdog force-release (stale ~10 min) | `release("watchdog")` → `notifyForceRelease` → `mutex_force_release` frame; the next cmd can re-acquire. |
| Two web tabs open | Both are the `"web"` frontend — they **share the single `web` driver slot**. The mutex is **tui-vs-web**, not web-vs-web (known v1 simplification — see §9). |

## 7. Test strategy

- **`WebTransport` (pure deep module)** — unit tests through its interface, **no real WS**:
  - inbound `parseCommand` + dispatch matrix: agentic → `handleInput` → `sendUserMessage` (deliverAs per op) vs `abort` vs appexec → bypass vs control → subscribe/unsubscribe;
  - outbound `mapEvent` for **every** event type — frame shape + `.details` preserved;
  - mutex routing matrix: idle → web acquires; web-while-tui-driving → `handled` + `notifyBlocked`.
- **`Broadcaster`** — in-memory sink adapter captures frames (unit); a thin integration opens a real WS to the `Bun.serve` and asserts frames arrive (the prod WS adapter).
- **`MutexNotifier`** — assert `notifyBlocked(blocked, by)` arg order + `notifyForceRelease(driver)` routing (mirror the ticket-03 controller tests).
- **Origin guard** — HTTP `403` + WS-upgrade-denied for non-loopback `Origin`; allowed for absent `Origin`.
- **Lifecycle** — singleton starts on first `session_start`, re-points on subsequent, drops the ref on `session_shutdown` (server survives), `.unref()` lets the process exit.
- **Deliberately NOT tested:** real frontend (06), approval dialogs (deferred), token auth (07).

## 8. Open questions (→ resolve in plan, non-blocking)

- **TypeBox vs Zod** — STEP-2 evidence leans **TypeBox** (prevalent, zero `zod`); confirm exact schemas in the plan.
- **Reconnect replay buffer** — v1 none; future.
- **Multiple web tabs** — v1 share the single `web` slot; future per-tab.
- **Exact `.details` field shapes per event** — pin in TDD tests during the plan.

## 9. Out of scope (v1)

- Real frontend / renderers (tickets 05 / 06).
- Approval dialogs (`select` / `confirm` / `input`) — later ticket.
- Token / bearer auth (ticket 07).
- Remote (non-loopback) / multi-user access.
- **Path-B** (CBOR `pi-server`) migration — the seam is shaped for it, but it is not implemented.
- `queue_update` deltas (need a pi patch); full `messages` / `isStreaming` / `isCompacting` (need a patch).
- Per-tab web driver slots (v1: all web tabs share one `web` driver).
- Reconnect replay buffer (v1: no missed-frame recovery).
