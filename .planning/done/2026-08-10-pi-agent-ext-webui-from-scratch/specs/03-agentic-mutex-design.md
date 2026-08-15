# 03 — Agentic mutex: design spec

- **Effort:** `2026-08-10-pi-agent-ext-webui-from-scratch`
- **Ticket:** `tickets/03-agentic-mutex-design.md` (type: prototype, blocked-by 02 ✅)
- **Status:** design approved (brainstorming) — pending implementation plan
- **Ground truth verified against:** pi v0.84.1 (installed)

## 1. Goal & scope

Make web-frontend and TUI **agent-driving turns mutually exclusive** on a single live `AgentSession`, while leaving **pure app-logic lock-free**. Whichever side initiates a model-driving turn holds an exclusive lock; the other is **hard-rejected** and shown "🔴 `<other>` is driving — not sent. Retry when idle."

**Locked by ticket 02 (do not re-litigate):**

- The mutex gate = the `input` extension event (`pi.on("input", …)`), zero monkey-patch.
- State model = a `driver: null | "tui" | "web"`, check-and-set **synchronously before the first `await`** (JS single-threading = atomic).
- Lock acquired only on turn-injecting calls (`prompt` / `steer` / `followUp` via `sendUserMessage`); pure app-logic never hits `prompt()` → never locks.
- Architecture = Path A (in-process `Bun.serve`, loopback).

**This spec decides:** the module shape (deep seam), the release trigger, the watchdog, blocked-side presentation, failure paths, and the test strategy.

## 2. Ground truth (verified, pi v0.84.1)

| Claim | Status | Evidence |
|---|---|---|
| `pi.on("input", h)` fires for every `prompt()` (TUI / extension / rpc), BEFORE the `isStreaming` guard | ✅ | `agent-session.js:814` emitInput; guard at `:838` |
| `event.source: "interactive" \| "rpc" \| "extension"` | ✅ | `types.d.ts:628-630` |
| Return contract: `{action:"handled"}` blocks (prompt returns, no turn); `{action:"transform", text, images?}` rewrites; `{action:"continue"}` passthrough | ✅ | `types.d.ts:635-643` (`InputEventResult`) |
| `agent_settled` fires after normal / abort / crash — the single reliable "agent stopped" event | ✅ | `agent-session.js:330`; docs `extensions.md:558-560` |
| `ctx.abort()` is synchronous; `agent_settled` still fires after it | ✅ | `agent-session.js:1168-1172` |
| `isStreaming` / `isCompacting` NOT on `ctx` (only on `AgentSession`) | ✅ | `agent-session.d.ts:291,316` |
| `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.model`, `ctx.signal` exist | ✅ | `types.d.ts:228-251` |

**Implication:** release on `agent_settled` (not `turn_end` — `agent_settled` correctly waits out queued follow-ups). Never branch on `isStreaming` (unavailable); use `agent_settled` + `ctx.isIdle()`.

## 3. The `AgentMutex` module (deep module)

A **deep module**: a lot of behaviour (state + transitions + watchdog) behind a tiny interface, at a clean seam, testable through that interface.

### Interface (the seam — what callers and tests cross)

```typescript
type Frontend = "tui" | "web";
type ReleaseReason = "settled" | "watchdog" | "shutdown";

interface GateResult {
  /** Maps directly onto InputEventResult.action: "continue" = passthrough, "handled" = block. */
  verdict: "continue" | "handled";
  /** Who holds the lock after this call (=== the acquiring frontend on a fresh acquire). */
  driver: Frontend | null;
  /** Present iff verdict === "handled" — tells the caller whom to blame in the reject notice. */
  blocked?: { by: Frontend };
}

interface AgentMutex {
  /** Synchronous check-and-set. Call from the input handler BEFORE any await. Pure: no I/O. */
  gate(source: InputSource): GateResult;
  /** Current lock holder, or null when idle. */
  readonly driver: Frontend | null;
  /** Release the lock. Idempotent. Safe to call when already idle. */
  release(reason: ReleaseReason): void;
  /** Reset the watchdog's inactivity timer. Call on every message_* / tool_* event. */
  bumpActivity(): void;
}
```

### State model (transition table)

`toFrontend(source)`: `interactive → "tui"`, `extension → "web"`, `rpc → null` (passthrough).

| From | Event | To | Side effect |
|---|---|---|---|
| `IDLE` (driver null) | `gate(interactive)` | `DRIVING_TUI` | — |
| `IDLE` | `gate(extension)` | `DRIVING_WEB` | — |
| `IDLE` | `gate(rpc)` | `IDLE` | rpc does not participate |
| `DRIVING_TUI` | `gate(interactive)` | `DRIVING_TUI` | same side → continue (followUp queues internally) |
| `DRIVING_TUI` | `gate(extension)` | `DRIVING_TUI` | **REJECT** + `blocked:{by:"tui"}` |
| `DRIVING_WEB` | `gate(extension)` | `DRIVING_WEB` | same side → continue |
| `DRIVING_WEB` | `gate(interactive)` | `DRIVING_WEB` | **REJECT** + `blocked:{by:"web"}` |
| `DRIVING_X` | `agent_settled` | `IDLE` | `release("settled")` |
| `DRIVING_X` | watchdog stale | `IDLE` | `release("watchdog")` + notify both |
| any | `session_shutdown` | dropped | `release("shutdown")` + cleanup |

### Implementation notes

- The flag is a single field `driver: Frontend | null`. `gate` is a synchronous check-and-set with no `await` between read and write — atomic by JS single-threading.
- `release` sets `driver = null`, stops the watchdog timer (if running), and is a no-op when already idle.
- The watchdog is owned by the module (started on acquire, stopped on release). Its clock is injectable for tests.
- **Depth check (deletion test):** delete `AgentMutex` and the input-handler wiring re-implements the flag, the same-side/other-side branches, the release-on-settled, and the watchdog across the extension — complexity reappears at the call site. The module earns its keep.

## 4. The seam: extension wiring (NOT the module's job)

The module is pure logic + a timer. The extension owns the I/O wiring. Sketch (illustrative — `sessionIdOf(ctx)` resolves the session id via `ctx.sessionManager.getSessionId()` or equivalent; real code subscribes to each event separately):

```typescript
// per-session mutex registry: the server is a module-level singleton that
// survives session switches; the mutex is PER-SESSION, keyed by sessionId.
const mutexes = new Map<string, AgentMutex>();

pi.on("input", (event, ctx) => {
  const m = mutexes.get(sessionIdOf(ctx));
  if (!m) return { action: "continue" };        // no mutex for this session yet
  const r = m.gate(event.source);                // synchronous, before any await
  if (r.verdict === "handled") {
    notifyBlocked(event.source, r.blocked!.by, ctx);
    return { action: "handled" };
  }
  return { action: "continue" };
});

pi.on("agent_settled", (_e, ctx) => mutexes.get(sessionIdOf(ctx))?.release("settled"));

// watchdog activity feed: reset the inactivity timer on agent work
for (const evt of ["message_update", "tool_execution_update"] as const) {
  pi.on(evt, (_e, ctx) => mutexes.get(sessionIdOf(ctx))?.bumpActivity());
}
```

- A mutex is created per `session_start` (with its watchdog config + an injected notify callback) and dropped on `session_shutdown` (`release("shutdown")`).
- One input handler (registered in the factory) resolves the per-session mutex from `ctx`; it does **not** capture a specific session.

## 5. Blocked-side presentation (hard-reject — decided)

The blocked submission is refused immediately; nothing is queued.

- **Blocked TUI** (web driving, TUI submits): `pi.ui.notify("🔴 web is driving — your message was not sent. Retry when idle.", "warning")`; return `{action:"handled"}`.
- **Blocked web** (tui driving, web submits): the web's `prompt()` returns immediately (handled); the extension's WS response carries `{ ok:false, blocked:true, by:"tui", message:"TUI is driving — not sent. Retry when idle." }` so the web UI renders the same banner.

No pending-queue state exists (deferred — §9). The user re-sends when idle.

## 6. Failure modes

| Failure | Mechanism | Release |
|---|---|---|
| `ctx.abort()` | synchronous; `agent_settled` still fires | `release("settled")` |
| Crashed / errored turn | `agent_settled` still fires (verified) | `release("settled")` |
| Hung turn (no settle) | watchdog: no `bumpActivity` for `STALE_MS` while `driver ≠ null` | `release("watchdog")` + notify both "force-released (timeout)" |
| Extension/server crash mid-turn (orphaned `driver`) | per-session mutex re-created on next `session_start` | fresh `IDLE` |
| Session switch (module singleton survives) | mutex keyed by `sessionId`; each session independent | no cross-session interference |

The watchdog reference is web-access's `setInterval(1000)` + `STALE_THRESHOLD_MS` pattern (`curator-server.ts:609-637`), adapted: tick 1000ms, force-release after `STALE_MS` of zero activity, reset on every `message_*` / `tool_*` event.

## 7. Testing strategy (TDD)

The deliverable says "specified **and tested**." Two layers:

**Unit (pure `AgentMutex`, injectable clock — no pi):**

- acquire from idle (tui / web); `driver` set correctly.
- same-side resubmit while driving → `continue`.
- other-side submit while driving → `handled` + correct `blocked.by`.
- `release` clears `driver`; idempotent (release-when-idle is a no-op).
- rpc → passthrough (no acquire).
- watchdog: force-releases after `STALE_MS` with no `bumpActivity`; resets on `bumpActivity`; does not fire while idle.

**Wiring (fake pi event emitter):**

- `gate` verdict → correct `InputEventResult` (`{action:"handled"|"continue"}`).
- `agent_settled` → `release("settled")`.
- blocked → notify called with the right `by` + message.
- `message_update` / `tool_execution_update` → `bumpActivity`.

## 8. Decisions log

- **Hard-reject (not queue)** for the blocked side — user decision (brainstorming Q1). Simplest correct state machine; no pending state; no reentrancy edges. Queue deferred (§9).
- **Release on `agent_settled`** (not `turn_end`) — verified to fire on success/abort/crash and to wait out queued follow-ups. One event, always.
- **Activity-based watchdog, 10-min hard cap** — pure app-logic turns don't take the lock, so the cap only bounds *agent* turns; activity reset prevents false release on legitimately long tool calls.
- **Per-session mutex** keyed by `sessionId` — the server is a module singleton, but the driver is about *this session's* agent.
- **rpc = passthrough** — loopback v1 has no rpc driver.
- **Rejected:** rich transition-state machine (contradicts the locked ticket-02 minimal flag; no leverage for 3 effective states); optimistic inject-then-reconcile (no mutual exclusion = the rejected auto-steer path).

## 9. Out of scope / deferred

- **Pending-queue for the blocked side** (v1.1): hold + auto-run on settle. Adds a pending-slot state + reentrancy edges.
- **`rpc` as a real driver** — only if a non-loopback / rpc frontend is introduced.
- **Queue-depth-aware blocking** — `queue_update` is not observable from an extension (ticket 01); would need a patch.
- **Multi-session web UI** — separate concern (map.md "Not yet specified").

## 10. Open question for the plan stage

**Execution mode (recommendation: real TDD module).** Build the `AgentMutex` as a **real, unit-tested module merged into `pi-agent-ext-webui`** (de-risk by building the riskiest part first), OR as a **throwaway logic prototype** (per the `prototype` skill) to validate the state model + failure paths, then fold the validated decision into real code in a later ticket? The success criteria ("specified **and tested**") leans real-module; confirm when invoking `writing-plans`.
