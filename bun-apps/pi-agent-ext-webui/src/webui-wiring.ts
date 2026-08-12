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
import { WebServer, type CommandHandler, type HttpRouteHandler } from "./web-server.js";
import type { Broadcaster } from "./broadcaster.js";
import type { ClientFrame, DispatchAction, WebFrame } from "./protocol.js";
import { RenderService } from "./render-service.js";
import { createRenderRoutes } from "./render-routes.js";
import { createRenderTool } from "./render-tool.js";
import { createRenderEventHandler } from "./render-event-handler.js";
import { createToolMirror } from "./tool-mirror.js";
import { resolvePort } from "./port-resolver.js";

/**
 * The event-bus surface the render framework needs (ticket 06 D2). The real
 * SDK `EventBus` is `{ emit(channel,data): void; on(channel,handler): () => void }`
 * — this mirrors exactly that so a MockPi stub is tiny.
 */
export interface RenderHostEvents {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

/**
 * The TUI UI surface the announce uses (ticket 07 D3/D4). Mirrors exactly the
 * two ExtensionUIContext members the announce calls (verified against the SDK
 * dist .d.ts): notify(message, type) + setStatus(key, text). `ui` lives on the
 * SESSION CONTEXT (the 2nd arg to session_start), NOT on the host — the SDK
 * ExtensionAPI has no `ui` member; ExtensionContext does. Narrow on purpose so
 * a MockPi ctx stub is tiny; the real ExtensionContext is a structural superset.
 */
export interface WebuiUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

/**
 * The session-context slice the wiring touches: abort() (unchanged — the
 * dispatch closure + bindSession still use it) + ui (new — the announce
 * channel). Widening this UNDOES the prior `ctx as { abort(): void }` downcast
 * so session_start can reach ctx.ui (specs/07 D3).
 */
export interface WebuiSessionCtx {
  abort(): void;
  ui: WebuiUi;
}

/**
 * The minimal pi host surface wireWebui touches: a many-event `on` registrar,
 * `sendUserMessage`, plus the ticket-06 render seams (`events` + `registerTool`).
 * Narrow on purpose so a MockPi in tests is tiny; the real {@link ExtensionAPI}
 * is a structural superset (assigned at the extensions/webui.ts entry via a cast).
 */
export interface WebuiHost {
  on(event: string, handler: (event: any, ctx: any) => any): void;
  sendUserMessage(
    content: string | unknown[],
    opts?: { deliverAs?: "steer" | "followUp" }
  ): void;
  /** Shared event bus (ticket 06 render channel "webui:render"). Optional —
   *  the render seam may be absent on host SDK builds that predate ticket 06;
   *  wiring no-ops the render registration then instead of throwing at boot. */
  events?: RenderHostEvents;
  /** Tool registrar (ticket 06 registers "webui_render"). Optional — see
   *  {@link events}; guarded so a host without the seam boots cleanly. */
  registerTool?(tool: unknown): void;
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
  setHttpRoutes(handler: HttpRouteHandler | null): void;
  /** OPTIONAL token auth (ticket 07 D1); null => no check (v1 loopback). */
  setTokenAuth(token: string | null): void;
  /**
   * The loopback URL the server is reachable on (throws "WebServer not started"
   * before start / after stop). Read lazily by the render framework's `urlFor`
   * (ticket 06 D7) to compose a view URL from the live port.
   */
  readonly url: string;
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
 * `WebTransport.mapEvent` (specs/04 §3). `agent_settled`, `message_update`, and
 * `tool_execution_update` are DUAL-purpose: they ALSO carry a gate handler
 * (release / activity / activity), so each is registered twice below — once in
 * the explicit gate section (handleSettled / handleActivity / handleActivity)
 * and again here for broadcast. The pi bus fires ALL handlers for an event, so
 * a `tool_execution_update` BOTH ticks activity (its gate handler) AND emits an
 * outbound frame (specs/04 §4 lists tool_execution_{start,update,end}).
 */
const OUTBOUND_EVENTS = [
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
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
  if (!singletonServer) singletonServer = new WebServer({ port: resolvePort() });
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
  // ticket 07 D1: loopback wiring — token OFF (null => no check). Loopback
  // binding + the DNS-rebinding-safe originAllowed guard is the v1 boundary;
  // the token mechanism stays AVAILABLE but OFF (a future non-loopback deployer
  // sets a non-null token). No shell-token injection: RENDER_SHELL_HTML is a
  // const and no request carries ?session=.
  server.setTokenAuth(null);
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

  // --- render framework (ticket 06 D2/D3) ---------------------------------
  // The registry is constructed here (not via deps) so it owns a urlFor bound
  // to THIS server. urlFor reads server.url lazily at render() time — the server
  // starts on the first session_start, which fires AFTER wireWebui returns, so
  // server.url is unavailable during wiring (the closure defers the read). After
  // dispose() (server.stop()) server.url throws "WebServer not started"; we catch
  // and fall back to the anchor form so a late render() never crashes the host.
  const registry = new RenderService({
    urlFor: (id) => {
      try {
        return `${server.url}/#${id}`;
      } catch {
        return `#${id}`;
      }
    },
  });
  server.setHttpRoutes(createRenderRoutes(registry));
  // Render-seam registration is guarded: a host whose ExtensionAPI predates
  // ticket 06 has no `events` bus / `registerTool` — wiring must not throw at
  // boot when those capabilities are absent (no-ops instead). See WebuiHost.
  pi.registerTool?.(createRenderTool(registry));
  pi.events?.on("webui:render", createRenderEventHandler(registry));

  // --- pi.on registration (each handler guarded by `disposed`) ---------------
  const reg = (event: string, handler: (event: any, ctx: any) => unknown): void => {
    pi.on(event, (event, ctx) => {
      if (disposed) return undefined;
      return handler(event, ctx);
    });
  };

  // --- tool-mirror (ticket 05) — third producer of RenderService ----------
  // Subscribes tool_result on the AGENT bus (pi.on) via the SAME reg() guard as
  // the outbound broadcast. tool_result is already in OUTBOUND_EVENTS (a second
  // handler that broadcasts verbatim); the pi bus fires ALL handlers, so this is
  // additive. NOT pi.events (that is the separate "webui:render" channel).
  reg("tool_result", createToolMirror(registry));

  // mutex gate — the input event handler returns the InputEventResult action.
  reg("input", (event) => controller.handleInput(event.source as InputSource));

  // release / activity (gate side of the dual-purpose events).
  reg("agent_settled", () => controller.handleSettled());
  reg("message_update", () => controller.handleActivity());
  reg("tool_execution_update", () => controller.handleActivity());

  // lifecycle — lazy server start on first session_start; re-point on subsequent.
  reg("session_start", (_event, ctx) => {
    server.start();
    const sessionCtx = ctx as WebuiSessionCtx;
    server.bindSession(pi, sessionCtx);
    bound = { pi, ctx: sessionCtx };
    // ticket 07 announce (specs/07 D3): surface the RESOLVED URL to the TUI user
    // via the SDK ui surface (notify + setStatus). NO console.log (it does not
    // reach the TUI user — debugging only); NO auto-open (the host exposes no
    // exec). server.url is read AFTER start(), so it reflects the bound port
    // (ephemeral or pinned — resolved via resolvePort in T2). start() is
    // idempotent + the singleton persists, so re-announces on
    // reload/new/resume/fork show the same stable URL.
    const url = server.url;
    sessionCtx.ui.notify(`webui: ${url}`, "info");
    sessionCtx.ui.setStatus("webui", url);
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
      server.setHttpRoutes(null);
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
