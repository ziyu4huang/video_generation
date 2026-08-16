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
 *  - The `input` extension event IS the mutex gate. ANY input (source
 *    "extension" vs "interactive") gates via MutexController.handleInput; a
 *    block returns {action:"handled"} and pi SUPPRESSES the message
 *    (agent-session.js short-circuits on "handled"), while the notifier
 *    broadcasts `mutex_blocked`. So block feedback is BROADCAST only — there
 *    is no per-command ack. DE-CHAT (event-cards 00): the wiring itself no
 *    longer produces `input` events — the retired agentic dispatch was the
 *    only `pi.sendUserMessage` caller (chat lives in the TUI); the gate stays
 *    for OTHER extension-sourced inputs on the shared host.
 *  - `appexec` BYPASSES the mutex entirely — it is the HITL return transport
 *    (spec Component 1): a typed `respond` descriptor resolves the pending
 *    Promise registered under its `id` (unknown ids are ignored), while
 *    session_shutdown / WS close abort every pending as {cancelled:true}.
 *  - The no-session guard runs BEFORE any pi/ctx deref: a command with no bound
 *    session replies `{type:"error",reason:"no_session"}` and returns.
 *
 * Testability: `deps` lets a test inject a MemoryBroadcaster + a FakeWebServer +
 * FakeClock so NO live pi and NO Bun.serve are required. The real prod path uses
 * the module-level WebServer singleton (the persistent co-frontend transport).
 */
import { MutexController, type MutexNotifier } from "./mutex-controller.js";
import { DEFAULT_WATCHDOG, type InputSource, type MutexClock, type MutexTimer } from "./mutex.js";
import { WebTransport } from "./web-transport.js";
import { WebServer, type CommandHandler, type HttpRouteHandler } from "./web-server.js";
import type { Broadcaster } from "./broadcaster.js";
import type { ClientFrame, DispatchAction, WebFrame } from "./protocol.js";
import { RenderService } from "./render-service.js";
import { createRenderRoutes } from "./render-routes.js";
import { createOutputRoutes } from "./output-routes.js";
import { createFileRoutes } from "./file-routes.js";
import { createBtwRoutes } from "./btw-routes.js";
import { createBtwForwarder, createBtwStore } from "./btw-store.js";
import { emitBtwCommand, onBtwEvent } from "./btw-channels.js";
import { createRenderEventHandler } from "./render-event-handler.js";
import { createPresentEventHandler } from "./present-event-handler.js";
import { createOpenEventHandler } from "./open-event-handler.js";
import { imageMd } from "./image-presentation.js";
import { resolveOutputDir } from "./output-routes.js";
import { createPresentTool, type PresentInput } from "./present-tool.js";
import { resolvePort } from "./port-resolver.js";
import { resolveFileRoots, resolveWebuiEnabled } from "./webui-config.js";
import { createSessionStore, type SessionStore } from "./session-store.js";

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
 * The session-context slice the wiring touches: `ui` (the announce +
 * block-feedback channel) + `modelRegistry` (btw panel D12). DE-CHAT
 * (event-cards 00): `abort()` is gone — the retired agentic dispatch was its
 * only wiring consumer (the Abort button rode the removed main composer).
 * Structural slice of the real ExtensionContext, which remains a superset;
 * narrowing on purpose keeps a MockPi ctx stub tiny.
 */
export interface WebuiSessionCtx {
  ui: WebuiUi;
  /** Model registry (btw panel D12): structural slice of the SDK's
   *  ExtensionContext.modelRegistry.getAvailable(). The real ExtensionContext
   *  remains a structural superset. */
  modelRegistry: { getAvailable(): Array<{ provider: string; id: string; api: string }> };
}

/**
 * The minimal pi host surface wireWebui touches: a many-event `on` registrar
 * plus the ticket-06 render seams (`events` + `registerTool`). DE-CHAT
 * (event-cards 00): no `sendUserMessage` — the retired agentic dispatch was
 * its only caller; the wiring no longer injects prompts into the session
 * (chat lives in the TUI; the btw side channel + HITL appexec are the
 * web-native input surfaces). Narrow on purpose so a MockPi in tests is
 * tiny; the real {@link ExtensionAPI} is a structural superset (assigned at
 * the extensions/webui.ts entry via a cast).
 */
export interface WebuiHost {
  on(event: string, handler: (event: any, ctx: any) => any): void;
  /** Shared event bus (ticket 06 render channel "webui:render"). Optional —
   *  the render seam may be absent on host SDK builds that predate ticket 06;
   *  wiring no-ops the render registration then instead of throwing at boot. */
  events?: RenderHostEvents;
  /** Tool registrar (the wiring registers "webui_present"). Optional — see
   *  {@link events}; guarded so a host without the seam boots cleanly. */
  registerTool?(tool: unknown): void;
}

/**
 * Minimal socket surface the WS-open snapshot seam needs (structural — Bun's
 * `ServerWebSocket` is a superset). Keeps webui-wiring.ts free of a Bun import
 * (the wiring stays host-agnostic; web-server.ts is the only Bun touchpoint).
 */
export interface WebuiSocket {
  send(data: string): void;
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
  /** WS-close abort seam (spec Component 1): invoked on each WS close so the
   *  wiring can resolve all pending HITL presentations as {cancelled:true}.
   *  Mirrors setCommandHandler/setHttpRoutes. */
  setWsCloseHandler(cb: (() => void) | null): void;
  /** WS-open snapshot seam (v2, architecture v2 §3.3): invoked on each WS open
   *  with the new socket so the wiring can push the connect-time session
   *  snapshot to THAT client. Mirrors setWsCloseHandler. */
  setWsOpenHandler(cb: ((ws: WebuiSocket) => void) | null): void;
  /** OPTIONAL connected-gate surface (ticket 01, spec §C1): the live client
   *  count + its change seam. Optional so minimal test fakes still satisfy the
   *  interface; when absent the tool degrades to the ungated v1 behavior. */
  readonly clientCount?: number;
  setClientsChangedHandler?(cb: ((count: number) => void) | null): void;
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
  /** Output dir for the /output serving route (spec Component 5). Default:
   *  env MLX_OUTPUT_DIR → ../video_generation__output vs cwd (see
   *  output-routes.ts). Injectable so wiring tests use a temp fixture. */
  outputDir?: string;
  /**
   * Optionality gate (architecture v2 §3.1): explicit override for the webui's
   * enabled state. Default: read env WEBUI_DISABLED (see webui-config.ts).
   * When disabled, wireWebui registers NOTHING (no pi.on handlers, no tool, no
   * server) and returns an inert {@link WebuiWiring}.
   */
  enabled?: boolean;
  /**
   * Port override for the WebServer singleton (architecture v2 §3.1). Default:
   * env WEBUI_PORT > PORT > 0 (see port-resolver.ts). Injectable so an
   * embedding host (or the pi-agent `--webui-port` flag) pins the port without
   * mutating process.env.
   */
  port?: number;
  /**
   * /files serving root allowlist (spec §4.1, archify-webui-html ticket 06):
   * explicit `deps.fileRoots` wins; otherwise env `WEBUI_FILE_ROOTS`
   * (`:`-separated, see webui-config.resolveFileRoots). Default `[]` = FAIL
   * CLOSED: the /files route serves uniform 404s and `webui:open` ignores
   * every path.
   */
  fileRoots?: string[];
}

/**
 * The structured HITL answer a blocked webui_present execute() resolves with:
 * a control response `{action: <controlId>, tweak?}` OR an abort
 * `{cancelled: true}` (session_shutdown / WS close / signal abort). Phase-2
 * ledger: tightened to a DISCRIMINATED UNION (was an all-optional bag) so a
 * consumer MUST branch on `cancelled` before reading `action`. Exported
 * alongside WebuiWiring (present-tool exports its types; same convention).
 */
export type HitlResponse = { action: string; tweak?: string } | { cancelled: true; reason?: string };

export interface WebuiWiring {
  /** Neutralize every handler + tear the server down (tests / session end). */
  dispose(): void;
  /**
   * Create + await a pending HITL presentation keyed by `id` (spec Component 1).
   * The `webui_present` tool calls this, then awaits the returned Promise.
   * Resolves with `{action, tweak?}` when an appexec `respond` arrives for the
   * id; resolves with `{cancelled:true}` on abort (session_shutdown / WS close /
   * tool-signal abort — `action` is ABSENT on a cancelled response by type).
   */
  registerPending(id: string): Promise<HitlResponse>;
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
function getServer(port: number): WebServer {
  if (!singletonServer) singletonServer = new WebServer({ port });
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
  // --- OPTIONALITY GATE (architecture v2 §3.1) ------------------------------
  // The webui is ON by default; opt out via env WEBUI_DISABLED or deps.enabled.
  // Disabled = register NOTHING and own nothing: no pi.on handlers, no tool,
  // no server, no event-bus subscriptions. registerPending resolves
  // {cancelled:true} immediately so any (mis-)caller fails fast instead of
  // hanging; dispose() is a no-op. This is the "TUI optionally uses the webui"
  // seam: a host that never calls wireWebui with enabled=true pays zero cost.
  if (!resolveWebuiEnabled(process.env, deps.enabled)) {
    return {
      dispose(): void {
        /* nothing was wired — nothing to tear down */
      },
      registerPending: (_id: string): Promise<HitlResponse> =>
        Promise.resolve({ cancelled: true }),
    };
  }
  // ticket 06 (archify-webui-html spec §4.1): /files root allowlist — resolved
  // ONCE here so the route and the webui:open handler anchor identically.
  const fileRoots = resolveFileRoots(process.env, deps.fileRoots);
  const server = deps.server ?? getServer(deps.port ?? resolvePort());
  // ticket 07 D1: loopback wiring — token OFF (null => no check). Loopback
  // binding + the DNS-rebinding-safe originAllowed guard is the v1 boundary;
  // the token mechanism stays AVAILABLE but OFF (a future non-loopback deployer
  // sets a non-null token). No shell-token injection: RENDER_SHELL_HTML is a
  // const and no request carries ?session=.
  server.setTokenAuth(null);
  const rawBroadcaster: Broadcaster = deps.broadcaster ?? server;
  // v2 session store (architecture v2 §3.3): EVERY outbound frame is appended
  // (bounded transcript) before fan-out, so a mid-session WS open can replay
  // history. The store wrapper is the single broadcast sink — the notifier and
  // the outbound event loop both go through it.
  const sessionStore: SessionStore = createSessionStore();
  const broadcaster: Broadcaster = {
    broadcast(frame: WebFrame): void {
      sessionStore.append(frame);
      rawBroadcaster.broadcast(frame);
    },
  };
  const clock = deps.clock ?? REAL_CLOCK;
  const notifier: MutexNotifier = {
    notifyBlocked(blocked, by) {
      broadcaster.broadcast({ type: "mutex_blocked", blocked, by });
    },
    notifyForceRelease(driver) {
      broadcaster.broadcast({ type: "mutex_force_release", driver });
      // v2 (architecture v2 §3.5): force-release feedback reaches the TUI user
      // too (v1 broadcast it only to browsers, which didn't even render it).
      bound?.ctx?.ui?.notify(
        `A web turn was force-released after inactivity (driver: ${driver}).`,
        "warning"
      );
    },
  };
  const controller = new MutexController({
    clock,
    watchdog: DEFAULT_WATCHDOG,
    notifier,
  });
  const transport = new WebTransport();

  // ctx widened to WebuiSessionCtx (vs the prior { abort(): void } downcast) so
  // the fire-once announce listener can reach ctx.ui. Dispatch only needs abort(),
  // which WebuiSessionCtx still provides (structural superset).
  let bound: { pi: WebuiHost; ctx: WebuiSessionCtx } | null = null;
  let disposed = false;

  // --- btw side-panel seam (Task 8) -----------------------------------------
  // Subscribed during factory setup, BEFORE any session_start fires, so the
  // forwarder catches btw's initial thread event (the store serves it to
  // GET /api/btw even pre-WS-connect). Every validated btw:event updates the
  // store AND broadcasts the `btw` WebFrame to connected WS clients (D5/D7).
  const btwStore = createBtwStore();
  const forwardBtwEvent = createBtwForwarder(btwStore, (frame) => server.broadcast(frame));
  // NOTE: onBtwEvent's bus param is non-optional, so the optional seam is
  // guarded here (same convention as the pi.events?.on render seams above).
  if (pi.events) onBtwEvent(pi.events, forwardBtwEvent);

  // --- HITL pending-Promise registry (return transport; spec Component 1) ----
  // Keyed by the respond `id`. registerPending creates + awaits a pending; the
  // dispatch appexec case resolves it; abort (session_shutdown / WS close /
  // tool-signal abort) resolves all pending as {cancelled:true}. The
  // webui_present tool is the producer (Phase 2, Task 2). In-memory only (spec
  // Decision C); cleared on resolve/abort. HitlResponse is the module-level
  // exported UNION — branch on "cancelled" in r before reading r.action.
  const pending = new Map<string, { resolve: (r: HitlResponse) => void }>();

  /**
   * v2 watchdog/present sync (architecture v2 §3.5): while a presentation is
   * pending, the agent turn is legitimately live with no activity — suspend the
   * stale watchdog so it never force-releases under the open presentation; the
   * session store's presentId reflects the pending so a snapshot tells the
   * browser a presentation is awaiting its answer.
   */
  function syncPendingState(): void {
    controller.setWatchdogSuspended(pending.size > 0);
    const id = pending.size === 1 ? [...pending.keys()][0]! : null;
    sessionStore.setPresentId(id);
  }

  function registerPending(id: string): Promise<HitlResponse> {
    return new Promise<HitlResponse>((resolve) => {
      // Duplicate-id safety (Phase-2 ledger): never silently overwrite — a
      // stale entry under the same id is resolved as {cancelled:true} FIRST so
      // its awaiter returns cleanly instead of hanging forever.
      const stale = pending.get(id);
      if (stale) {
        pending.delete(id);
        stale.resolve({ cancelled: true });
      }
      pending.set(id, { resolve });
      syncPendingState();
    });
  }

  /** Resolve every pending as {cancelled:true} (session_shutdown / WS close).
   *  `reason` (ticket 01) rides along on the no-client auto-release. */
  function cancelAllPending(reason?: string): void {
    for (const entry of pending.values())
      entry.resolve(reason !== undefined ? { cancelled: true, reason } : { cancelled: true });
    pending.clear();
    syncPendingState();
  }

  /** Cancel ONE pending as {cancelled:true} (the webui_present tool's
   *  signal-abort path); `reason` tags the no-client connected-gate release. */
  function cancelPending(id: string, reason?: string): void {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve(reason !== undefined ? { cancelled: true, reason } : { cancelled: true });
      syncPendingState();
    }
  }

  // --- inbound dispatch seam (handed to WebServer.setCommandHandler) ---------
  // web-server.ts ALREADY validated the frame (validateInbound) before invoking
  // this seam, so `frame` is a typed ClientFrame; parseCommand classifies it.
  const onCommand: CommandHandler = (frame: ClientFrame, reply) => {
    if (disposed) return;
    // ask-user bridge (§C3): answers ride the loose appexec extra record.
    // Forward to the host bus; ask-user's execute correlates by promptId.
    // (Ahead of parseCommand: the loose ask_user_answer extra resolves to
    // null there, and the early-return below would drop it before this seam.)
    if (
      frame.type === "appexec" &&
      (frame.extra as { kind?: string } | undefined)?.kind === "ask_user_answer"
    ) {
      const a = frame.extra as { promptId?: string; result?: unknown };
      pi.events?.emit("rpiv:ask-user:answer", {
        promptId: typeof a.promptId === "string" ? a.promptId : "",
        result: a.result,
      });
      return; // early-exit so the existing respond path is untouched below
    }
    const action = transport.parseCommand(frame);
    if (!action) return; // unknown type — ignore (defensive tail)
    // NO-SESSION guard: never deref a null session (specs/04 §6).
    if (bound === null) {
      reply({ type: "error", reason: "no_session" });
      return;
    }
    dispatch(action);
  };

  function dispatch(action: DispatchAction): void {
    switch (action.kind) {
      case "agentic":
        // RETIRED (event-cards 00, de-chat): chat lives in the TUI — the served
        // shell's main composer is gone. prompt/steer/followUp/abort frames
        // still VALIDATE (protocol) and parse (web-transport) but are
        // deliberately NOT routed to pi.sendUserMessage / ctx.abort. The
        // browser's web-native input surface is the btw side channel + HITL
        // appexec (below).
        break;
      case "appexec": {
        // Phase 1 return transport (spec Component 1): `action` is the typed
        // respond descriptor (Task 1). Resolve the pending Promise keyed by id;
        // an unknown id is ignored (no pending was registered for it). MUST
        // bypass the mutex (the wiring already branched on `kind === "agentic"`).
        // v2 adds the `cancel` op (architecture v2 §3.4): the browser's Cancel
        // button resolves THIS pending as {cancelled:true} — unlike WS close,
        // which cancels every pending and forces a re-present.
        if (action.op === "cancel") {
          cancelPending(action.id);
          break;
        }
        const entry = pending.get(action.id);
        if (entry) {
          pending.delete(action.id);
          entry.resolve(
            action.tweak !== undefined
              ? { action: action.action, tweak: action.tweak }
              : { action: action.action }
          );
          syncPendingState();
        }
        break;
      }
      case "btw":
        // Side-panel command path (Task 6/8): forward the validated BtwCommand
        // to the btw thread over the shared event bus. NOT agentic — never
        // touches the mutex or the pending HITL registry. Guarded like the
        // render seams: a host without an events bus no-ops instead of throwing.
        if (pi.events) emitBtwCommand(pi.events, action.command);
        break;
      case "control":
        // subscribe/unsubscribe: WS connect/close already auto-tracks clients
        // in WebServer; the explicit command is a v1 no-op.
        break;
    }
  }

  server.setCommandHandler(onCommand);

  // WS-close abort seam (spec Component 1): a disconnect mid-HITL resolves all
  // pending as {cancelled:true} so a blocked execute() returns cleanly.
  // KNOWN TENSION (Phase-2 ledger, DOCUMENTED not changed): a browser REFRESH
  // mid-presentation also closes the WS, so the blocked execute() resolves
  // {cancelled:true} and the agent must RE-PRESENT. The minted present view
  // survives in the replace-only store (a reconnecting browser can re-fetch it
  // via /api/view/:id for display), but the pending GATE does not survive.
  // Re-attaching a pending presentation to a reconnect is deferred (spec
  // Decision A/C future work).
  server.setWsCloseHandler(() => cancelAllPending());

  // v2 connect-time snapshot (architecture v2 §3.3): on EVERY ws open, push the
  // accumulated session state to THAT client before any live frames — a browser
  // opening mid-session (or refreshing) sees the agent history instead of an
  // empty page. The store is append-only from broadcasts, so the snapshot is
  // authoritative (research lesson: pi-client "no optimistic state").
  server.setWsOpenHandler((ws) => {
    try {
      ws.send(JSON.stringify({ type: "snapshot", state: sessionStore.snapshot() }));
    } catch {
      /* socket closed between open and send — fire-and-forget */
    }
  });

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
  // Phase 4 (spec Component 5): chain the /output serving route BEHIND the
  // render routes — render answers first (incl. GET / shell), output serves
  // /output/{...}, everything else falls through to the WebServer defaults.
  const renderRoutes = createRenderRoutes(registry);
  // ticket 06 (archify-webui-html spec §4.1): /files serves full-fidelity HTML
  // from the configured root allowlist — chained AFTER render routes, BEFORE
  // output routes (the spec-pinned registration order).
  const fileRoutes = createFileRoutes({ roots: fileRoots });
  const outputRoutes = createOutputRoutes(deps.outputDir !== undefined ? { dir: deps.outputDir } : undefined);
  // Task 8: btw routes answer FIRST (/api/btw, /api/btw/models); render and
  // output keep their existing order behind them. Model list is read from the
  // BOUND session's registry (null pre-session_start -> empty list; the
  // panel refetches after connect). The provider/id/api mapping mirrors the
  // btw override-entry payload convention.
  server.setHttpRoutes(
    (req, srv) =>
      createBtwRoutes({
        getState: () => btwStore.state(),
        getModels: () =>
          (bound?.ctx.modelRegistry?.getAvailable() ?? []).map((m) => ({
            provider: m.provider,
            id: m.id,
            api: m.api,
          })),
      })(req, srv) ?? renderRoutes(req, srv) ?? fileRoutes(req, srv) ?? outputRoutes(req, srv),
  );
  // Render-seam registration is guarded: a host whose ExtensionAPI predates
  // ticket 06 has no `events` bus / `registerTool` — wiring must not throw at
  // boot when those capabilities are absent (no-ops instead). See WebuiHost.
  // v2 (render-review F3): the render/present handlers accept an `images`
  // payload (output paths) and append ![image](/output/0/<rel>) markdown via
  // imageMd — wiring the previously-dead image-presentation helpers into a
  // producer. The converter is bound to the same resolved output dir the
  // /output serving route uses (deps.outputDir or env/default).
  const toImageMarkdown = (paths: string[]): string => {
    const outputDir = resolveOutputDir(deps.outputDir);
    return paths
      .map((p) => imageMd(p, outputDir))
      .filter((s): s is string => s !== null)
      .join("\n\n");
  };
  pi.events?.on("webui:render", createRenderEventHandler(registry, { toImageMarkdown }));
  const presentHandler = createPresentEventHandler(registry, { toImageMarkdown });
  pi.events?.on("webui:present", presentHandler);
  // ticket 06 (archify-webui-html spec §4.2): the `webui:open` channel — any
  // extension (archify; wayfind-style string-literal contract, no import)
  // may emit {path, view?, title?}. The handler validates against the SAME
  // roots the /files route serves and announces the URL via the BOUND
  // session's ui (null before session_start -> notify no-ops). server.url is
  // read LAZILY (the server starts at session_start, after wiring returns)
  // and trailing-slash-stripped so exactly one slash precedes /files.
  // Ticket 06 view-notifications (spec 02-A): the seam ALSO upserts the URL
  // into the render registry (mode:"url", id-stable re-open) and broadcasts
  // the `view_opened` frame through the STORE-WRAPPED broadcaster (so it
  // rides live fan-out AND the connect-time transcript replay).
  // Guarded like the render seams above: a host without an events bus no-ops.
  pi.events?.on(
    "webui:open",
    createOpenEventHandler(fileRoots, {
      getUrl: () => {
        try {
          return server.url.replace(/\/$/, "");
        } catch {
          return ""; // server not started/stopped — announce a bare /files path
        }
      },
      notify: (message) => bound?.ctx?.ui?.notify(message),
      registerView: (input) => registry.openUrl(input),
      broadcast: (frame) => broadcaster.broadcast(frame),
    })
  );

  // ask-user bridge (§C3): the core-task questionnaire prompt mirrored as a
  // replay-eligible ask_user frame. Browser answers ride the EXISTING loose
  // appexec channel (extra.kind:"ask_user_answer" — schema-loose by design) and
  // are re-emitted on the host bus as rpiv:ask-user:answer, which ask-user's
  // execute consumes via its doneRef. No cross-package import either direction.
  pi.events?.on("rpiv:ask-user:prompt", (payload: unknown) => {
    const p = payload as { promptId?: string; questions?: unknown[] } | undefined;
    broadcaster.broadcast({
      type: "ask_user",
      promptId: typeof p?.promptId === "string" ? p.promptId : "",
      questions: Array.isArray(p?.questions) ? p.questions : [],
      ts: Date.now(),
    });
  });

  // ask-user tombstone (webui-tui-parity C1): every questionnaire exit emits
  // rpiv:ask-user:answered — broadcast it so live + replaying shells retire
  // the dialog. String-literal contract; no task-package import.
  pi.events?.on("rpiv:ask-user:answered", (payload: unknown) => {
    const p = payload as { promptId?: string } | undefined;
    broadcaster.broadcast({ type: "ask_user_done", promptId: typeof p?.promptId === "string" ? p.promptId : "" });
  });

  // webui_present (the blocking HITL gate, spec Component 2): the `present` dep
  // emits the webui:present event (the registered handler mints the view). If
  // the host has NO shared event bus (guarded seam), fall back to invoking the
  // handler directly so the view is still minted. Returns the presentId that
  // keys the pending registry.
  const present = (input: PresentInput): string => {
    const payload = {
      content: input.content,
      controls: input.controls,
      id: input.id,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.view !== undefined ? { view: input.view } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
    };
    if (pi.events) pi.events.emit("webui:present", payload);
    else presentHandler(payload);
    return input.id;
  };
  pi.registerTool?.(
    createPresentTool({
      present,
      registerPending,
      hasPending: () => pending.size > 0,
      cancelPending,
      // Connected-gate surface (ticket 01, spec §C1): live client count + the
      // server's single-slot change seam. getClientCount returning undefined
      // (fake server without the field) never gates — ungated v1 behavior.
      // The unsubscribe detaches the slot; the tool calls it on EVERY
      // settlement, so no handler outlives a presentation. dispose() also
      // nulls the slot as the belt-and-suspenders teardown.
      getClientCount: () => server.clientCount,
      ...(server.setClientsChangedHandler
        ? {
            onClientsChanged: (cb: (count: number) => void): (() => void) => {
              server.setClientsChangedHandler!(cb);
              return () => server.setClientsChangedHandler!(null);
            },
          }
        : {}),
    })
  );

  // --- pi.on registration (each handler guarded by `disposed`) ---------------
  const reg = (event: string, handler: (event: any, ctx: any) => unknown): void => {
    pi.on(event, (event, ctx) => {
      if (disposed) return undefined;
      return handler(event, ctx);
    });
  };

  reg("input", (event) => {
    const source = event.source as InputSource;
    const r = controller.handleInput(source);
    // v2 (architecture v2 §3.5): block feedback reaches the TUI user too —
    // v1 only broadcast a mutex_blocked frame (which the browser didn't even
    // render). A suppressed INTERACTIVE (TUI) submission is the silent-stall
    // case worth surfacing; web-side blocks are already visible in the browser.
    if (r.action === "handled" && source === "interactive" && bound?.ctx?.ui) {
      bound.ctx.ui.notify(
        "The web UI is driving the session — your input was blocked until the current turn settles.",
        "warning"
      );
    }
    return r;
  });

  // release / activity (gate side of the dual-purpose events).
  reg("agent_settled", () => controller.handleSettled());
  reg("message_update", () => controller.handleActivity());
  reg("tool_execution_update", () => controller.handleActivity());

  // lifecycle — lazy server start on first session_start; re-point on subsequent.
  reg("session_start", (_event, ctx) => {
    // v2 (architecture v2 §3.5): defensively reset the mutex for the new
    // session — v1 kept a process-wide lock across sessions, so a stale driver
    // could block a fresh session. handleShutdown() is an idempotent release.
    controller.handleShutdown();
    // v2 guard (review): a full port-walk exhaustion makes start() throw —
    // catch it so the failure surfaces to the TUI user instead of escaping
    // into pi's session_start event dispatch.
    try {
      server.start();
    } catch (e) {
      const ui = (ctx as WebuiSessionCtx | undefined)?.ui;
      ui?.notify(
        `webui failed to start (port range exhausted): ${(e as Error)?.message ?? String(e)}`,
        "error"
      );
      return; // do NOT bind a session against a dead server
    }
    const sessionCtx = ctx as WebuiSessionCtx;
    server.bindSession(pi, sessionCtx);
    bound = { pi, ctx: sessionCtx };
    // session info status (webui-tui-parity C2): TUI-parity context for the
    // shell header — which worktree/branch this browser tab co-drives.
    let branch = "";
    try {
      branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd() }).stdout.toString().trim();
    } catch {
      /* best-effort */
    }
    broadcaster.broadcast({ type: "session_info", cwd: process.cwd(), branch: branch || undefined });
    // ticket 07 announce (specs/07 D3): surface the RESOLVED URL to the TUI user
    // via the SDK ui surface (notify + setStatus). NO console.log (it does not
    // reach the TUI user — debugging only); NO auto-open (the host exposes no
    // exec). The announce is DEFERRED to the FIRST render — see the fire-once
    // registry listener below — because the webui is a render surface and
    // announcing at session_start (before any content exists) is noise.
    // server.url is read inside that listener, which fires only AFTER start()
    // has run here. start() is idempotent + the singleton persists, so rebinds
    // on reload/new/resume/fork keep the same stable URL.
  });
  reg("session_shutdown", () => {
    controller.handleShutdown();
    cancelAllPending();
    server.dropSession();
    bound = null;
    // v2: the server survives session shutdown, but the next session must not
    // inherit this session's transcript (architecture v2 §3.3).
    sessionStore.clear();
  });

  // ticket 04 (refined): announce the resolved URL ONLY when the first content is
  // rendered — not at session_start. The webui is a render surface; announcing
  // before any content exists is noise. Fire once (first render ever) via a
  // registry listener. server.start() runs at session_start before any render
  // can fire, so server.url is safe to read here. Uses the bound session's ctx.ui.
  //
  // v2 latch fix (architecture v2, review): the latch was set BEFORE the ui
  // guard, so a render firing before the first session_start (no bound ctx)
  // permanently suppressed the announce. The latch is now armed only when the
  // announce is actually emitted, and the server.url read is guarded (a render
  // before start() would otherwise throw inside the registry subscriber — which
  // swallows it, but only after the latch was already burnt).
  let announced = false;
  registry.subscribe(() => {
    if (announced) return;
    const ui = bound?.ctx?.ui;
    if (!ui) return;
    announced = true;
    let url: string;
    try {
      url = server.url;
    } catch {
      return; // server not started yet — a later render will re-attempt
    }
    ui.notify(`webui ready — open ${url} in a browser to view rendered results and send feedback. (loopback · no auth)`, "info");
    ui.setStatus("webui", `🌐 webui · ${url} · open in browser to view results`);
  });

  // outbound broadcast — mapEvent forwards .details/.toolName verbatim. The
  // wrapped `broadcaster` appends every frame to the session store first, so a
  // later WS open can replay the transcript (v2 snapshot).
  for (const ev of OUTBOUND_EVENTS) {
    reg(ev, (event) => broadcaster.broadcast(transport.mapEvent(event)));
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      server.setHttpRoutes(null);
      server.setCommandHandler(null);
      server.setWsCloseHandler(null);
      server.setWsOpenHandler(null);
      server.setClientsChangedHandler?.(null);
      cancelAllPending();
      controller.handleShutdown();
      server.dropSession();
      bound = null;
      sessionStore.clear();
      server.stop();
    },
    registerPending,
  };
}

// Re-export the wire types the entry + consumers need (single import surface).
export type { WebFrame };
