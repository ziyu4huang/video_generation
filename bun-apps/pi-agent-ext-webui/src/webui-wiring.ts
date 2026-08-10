/**
 * webui-wiring.ts — the Task 3b composition root (specs/04 §3/§6).
 *
 * `wireWebui(pi, deps?)` is the ONE place that composes the Task 0–3a deep
 * modules into a live pi extension:
 *
 *   WebServer (singleton, the volatile transport) ──implements──▶ Broadcaster
 *        ▲                                                     │
 *        │ bind/drop/start/stop/setCommandHandler              ▼
 *   wireWebui ──builds──▶ BroadcastingNotifier(broadcaster) ──▶ MutexController
 *                     └─ WebTransport (pure parse/map)              │
 *                                                                     ▼
 *   pi.on(input|agent_settled|message_update|tool_execution_update) → gate
 *   pi.on(session_start|session_shutdown)                         → lifecycle
 *   pi.on(message_*|tool_*|turn_*|agent_settled|session_*compact) → broadcast
 *
 * CRITICAL invariants (specs/04 §6):
 *  - The `input` extension event IS the mutex gate. The inbound dispatch closure
 *    does NOT pre-gate: it calls `pi.sendUserMessage(text)`, which fires pi's
 *    internal `input` event (source "extension"). That event's handler gates via
 *    MutexController.handleInput; a block returns {action:"handled"} and pi
 *    SUPPRESSES the message (agent-session.js short-circuits on "handled"), while
 *    the notifier broadcasts `mutex_blocked`. So block feedback is BROADCAST
 *    only — there is no per-command ack.
 *  - `appexec` BYPASSES the mutex entirely (no concrete v1 ops; forward seam).
 *  - The no-session guard runs BEFORE any pi/ctx deref: a command with no bound
 *    session replies `{type:"error",reason:"no_session"}` and returns.
 *
 * Testability: `deps` lets a test inject a MemoryBroadcaster + a FakeWebServer +
 * FakeClock so NO live pi and NO Bun.serve are required. The real prod path uses
 * the module-level WebServer singleton (the persistent co-frontend transport).
 */
import { MutexController, type MutexNotifier } from "./mutex-controller.js";
import { DEFAULT_WATCHDOG, type InputSource, type MutexClock, type MutexTimer } from "./mutex.js";
import { BroadcastingNotifier } from "./notifier.js";
import { WebTransport } from "./web-transport.js";
import { WebServer, type CommandHandler } from "./web-server.js";
import type { Broadcaster } from "./broadcaster.js";
import type { ClientFrame, DispatchAction, WebFrame } from "./protocol.js";

/**
 * The minimal pi host surface wireWebui touches: a many-event `on` registrar
 * and `sendUserMessage`. Narrow on purpose so a MockPi in tests is tiny; the
 * real {@link ExtensionAPI} is a structural superset (assigned at the
 * extensions/webui.ts entry via a cast).
 */
export interface WebuiHost {
  on(event: string, handler: (event: any, ctx: any) => any): void;
  sendUserMessage(
    content: string | unknown[],
    opts?: { deliverAs?: "steer" | "followUp" }
  ): void;
}

/**
 * The server lifecycle surface wireWebui drives. The real {@link WebServer}
 * satisfies this (it also implements {@link Broadcaster}, so it serves as its
 * own default broadcaster in prod). Tests inject a fake.
 */
export interface WebuiServer extends Broadcaster {
  start(): void;
  bindSession(pi: unknown, ctx: unknown): void;
  dropSession(): void;
  hasSession(): boolean;
  setCommandHandler(cb: CommandHandler | null): void;
  stop(): void;
}

export interface WebuiDeps {
  /** Outbound sink. Default: the server itself (WebServer IS a Broadcaster). */
  broadcaster?: Broadcaster;
  /** Injectable clock (deterministic watchdog in tests). */
  clock?: MutexClock;
  /** Server lifecycle handle. Default: the module-level WebServer singleton. */
  server?: WebuiServer;
}

export interface WebuiWiring {
  /** Neutralize every handler + tear the server down (tests / session end). */
  dispose(): void;
}

/**
 * Outbound host events forwarded verbatim to web clients via
 * `WebTransport.mapEvent` (specs/04 §3). `agent_settled` and `message_update`
 * are DUAL-purpose: they ALSO carry a gate handler (release / activity), so each
 * is registered twice (the pi bus supports multiple handlers per event).
 * Note: `tool_execution_update` is gate-only (activity) — intentionally absent
 * from the outbound set per the task-3b contract.
 */
const OUTBOUND_EVENTS = [
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "tool_result",
  "turn_start",
  "turn_end",
  "agent_settled",
  "session_before_compact",
  "session_compact",
] as const;

// --- module-level WebServer singleton (persistent co-frontend transport) ----
let singletonServer: WebServer | null = null;
function getServer(): WebServer {
  if (!singletonServer) singletonServer = new WebServer({ port: 0 });
  return singletonServer;
}

/** Real wall clock + interval (the prod default for MutexClock). */
const REAL_CLOCK: MutexClock = {
  now: () => Date.now(),
  setInterval(handler: () => void, ms: number): MutexTimer {
    const id = globalThis.setInterval(handler, ms);
    return { clear: () => globalThis.clearInterval(id) };
  },
};

/**
 * Compose the webui extension. Idempotent w.r.t. the singleton server (a second
 * call re-points the session + command handler but reuses the live transport).
 */
export function wireWebui(pi: WebuiHost, deps: WebuiDeps = {}): WebuiWiring {
  const server = deps.server ?? getServer();
  const broadcaster: Broadcaster = deps.broadcaster ?? server;
  const clock = deps.clock ?? REAL_CLOCK;
  const notifier: MutexNotifier = new BroadcastingNotifier(broadcaster);
  const controller = new MutexController({
    clock,
    watchdog: DEFAULT_WATCHDOG,
    notifier,
  });
  const transport = new WebTransport();

  let bound: { pi: WebuiHost; ctx: { abort(): void } } | null = null;
  let disposed = false;

  // --- inbound dispatch seam (handed to WebServer.setCommandHandler) ---------
  // web-server.ts ALREADY validated the frame (validateInbound) before invoking
  // this seam, so `frame` is a typed ClientFrame; parseCommand classifies it.
  const onCommand: CommandHandler = (frame: ClientFrame, reply) => {
    if (disposed) return;
    const action = transport.parseCommand(frame);
    if (!action) return; // unknown type — ignore (defensive tail)
    // NO-SESSION guard: never deref a null session (specs/04 §6).
    if (bound === null) {
      reply({ type: "error", reason: "no_session" });
      return;
    }
    dispatch(action, bound);
  };

  function dispatch(action: DispatchAction, session: { pi: WebuiHost; ctx: { abort(): void } }): void {
    switch (action.kind) {
      case "agentic":
        // The input event IS the mutex gate — do NOT pre-gate. sendUserMessage
        // fires pi's internal input event (source "extension"); on a block pi
        // suppresses delivery and the notifier broadcasts mutex_blocked.
        switch (action.op) {
          case "prompt":
            session.pi.sendUserMessage(action.text ?? "");
            break;
          case "steer":
            session.pi.sendUserMessage(action.text ?? "", { deliverAs: "steer" });
            break;
          case "followUp":
            session.pi.sendUserMessage(action.text ?? "", { deliverAs: "followUp" });
            break;
          case "abort":
            session.ctx.abort();
            break;
        }
        break;
      case "appexec":
        // v1 NO-OP — forward seam; MUST bypass the mutex (specs/04 §3/§6).
        break;
      case "control":
        // subscribe/unsubscribe: WS connect/close already auto-tracks clients
        // in WebServer; the explicit command is a v1 no-op.
        break;
    }
  }

  server.setCommandHandler(onCommand);

  // --- pi.on registration (each handler guarded by `disposed`) ---------------
  const reg = (event: string, handler: (event: any, ctx: any) => unknown): void => {
    pi.on(event, (event, ctx) => {
      if (disposed) return undefined;
      return handler(event, ctx);
    });
  };

  // mutex gate — the input event handler returns the InputEventResult action.
  reg("input", (event) => controller.handleInput(event.source as InputSource));

  // release / activity (gate side of the dual-purpose events).
  reg("agent_settled", () => controller.handleSettled());
  reg("message_update", () => controller.handleActivity());
  reg("tool_execution_update", () => controller.handleActivity());

  // lifecycle — lazy server start on first session_start; re-point on subsequent.
  reg("session_start", (_event, ctx) => {
    server.start();
    const sessionCtx = ctx as { abort(): void };
    server.bindSession(pi, sessionCtx);
    bound = { pi, ctx: sessionCtx };
  });
  reg("session_shutdown", () => {
    controller.handleShutdown();
    server.dropSession();
    bound = null;
  });

  // outbound broadcast — mapEvent forwards .details/.toolName verbatim.
  for (const ev of OUTBOUND_EVENTS) {
    reg(ev, (event) => broadcaster.broadcast(transport.mapEvent(event)));
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      server.setCommandHandler(null);
      controller.handleShutdown();
      server.dropSession();
      bound = null;
      server.stop();
    },
  };
}

// Re-export the wire types the entry + consumers need (single import surface).
export type { WebFrame };
