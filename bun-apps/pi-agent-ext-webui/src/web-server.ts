/**
 * web-server.ts — the volatile transport adapter and the ONLY `Bun.serve`
 * touch-point (specs/04 §3, §2).
 *
 * Implements {@link Broadcaster} over a WS client-set (lifted from
 * gui-movie-director/api/ws.ts `connectedClients` + `broadcastMessage`). Owns:
 *  - HTTP `fetch`: `/health` (200 "ok") + a stub connect-test page + `/ws` upgrade;
 *  - `websocket` handlers (`open`/`message`/`close`) over `connectedClients`;
 *  - the shared `originAllowed` guard (COPIED inline from
 *    gui-movie-director/lib/origin.ts) applied identically to HTTP fetch AND the
 *    WS upgrade (spec §2);
 *  - an INLINE copy of `serveWithFallback` (gui-movie-director/server.ts — NOT a
 *    lib export; copying keeps this prototype extension decoupled from the
 *    sibling app);
 *  - `.unref()` on the server handle — webui is EMBEDDED in the agent process, so
 *    the server must NOT keep the process alive on its own (gui-movie-director is
 *    a foreground dev server and does NOT unref; we ADD it — spec §2, §3);
 *  - the module-level singleton lifecycle: `start()` (lazy + idempotent),
 *    `bindSession(pi, ctx)` (re-point per session_start), `dropSession()` (null
 *    the ref on session_shutdown — the server SURVIVES; persistent co-frontend,
 *    NOT closeAll/stop — spec §6).
 *
 * Deliberately does NOT import the pure dispatch module (Task 1): inbound commands
 * are handed to an injected `onCommand` callback (set via {@link
 * WebServer.setCommandHandler} by extensions/webui.ts, Task 3) so the adapter
 * stays volatile and protocol-free.
 * The no-session guard (`no_session` reply) also lives in Task 3's closure —
 * expose {@link WebServer.hasSession} so the closure can guard without the
 * adapter dereferencing pi/ctx.
 *
 * Purity note: this is the VOLATILE TRANSPORT ADAPTER — importing `Bun` is its
 * job. The no-runtime-pi/no-Bun invariant applies only to protocol.ts + the pure
 * dispatch module (Task 1).
 */
import type { Server, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { Broadcaster } from "./broadcaster.js";
import type { ClientFrame, WebFrame } from "./protocol.js";
import { validateInbound } from "./protocol.js";

// --- origin guard (COPIED inline from gui-movie-director/lib/origin.ts) ------
// DNS-rebinding-safe loopback Host-header guard, shared identically on HTTP
// fetch and the WS upgrade (spec §2).
//
// v2 hardening (architecture v2 §3.2): the Host header HOSTNAME is now
// validated for EVERY request, independent of Origin. v1 only extracted the
// port from Host and allowed any no-Origin request through — a classic
// DNS-rebinding navigation (attacker page rebinds attacker.com -> 127.0.0.1
// and navigates; same-origin GETs carry NO Origin header) could then
// same-origin-read /api/views, /api/view/:id, /api/logs and /output/* with
// Host: attacker.com. Requiring a loopback Host hostname unconditionally
// closes that read-exfiltration vector; an absent Origin (curl/scripts) is
// still allowed, but only when the Host hostname is loopback.
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** Host-header hostname (port stripped, IPv6 brackets kept, case-folded). */
function hostHostname(host: string | null): string {
  if (!host) return "";
  const h = host.toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  return h.split(":")[0] ?? "";
}

function originAllowed(origin: string | null, host: string | null): boolean {
  // 1) Host hostname MUST be loopback — every request, with or without Origin.
  if (!LOOPBACK_HOSTS.includes(hostHostname(host))) return false;
  // 2) A present Origin must be same-origin loopback for the bound port.
  if (!origin) return true; // absent Origin (curl/scripts) allowed — Host already loopback
  if (host === null) return false; // unreachable (hostHostname(null) === "") — narrows for TS
  // Extract port from the Host header (IPv6 addresses are bracketed). A
  // present-but-portless Host yields port="" (webui binds EPHEMERAL — no fixed
  // default like gui-movie-director's DEFAULT_PORT="3099"), so it can never
  // match a real loopback Origin `http://<host>:<port>`; deny-by-default here
  // TIGHTENS (not loosens) the guard.
  const portMatch = host.match(/:(\d+)$/);
  const port = portMatch ? portMatch[1] : "";
  return LOOPBACK_HOSTS.some((h) => origin === `http://${h}:${port}`);
}

/**
 * Read the presented auth token for the OPTIONAL token check (ticket 07 D1).
 * Precedence (v2, architecture v2 §3.2): the `x-webui-token` header FIRST — it
 * does not leak into browser history / referrers / server logs the way a query
 * string does; then `body.token` (POST JSON, read via clone() so a downstream
 * additive route can still read the body); finally the legacy `?session=` query
 * param (kept for compatibility). Returns null when absent / unparseable. Only
 * called when this.token !== null.
 */
async function readPresentedToken(req: Request, url: URL): Promise<string | null> {
  const header = req.headers.get("x-webui-token");
  if (header) return header;
  if (req.method === "POST") {
    try {
      const body = await req.clone().json();
      return typeof body?.token === "string" ? body.token : null;
    } catch {
      return null;
    }
  }
  return url.searchParams.get("session");
}

/**
 * Constant-time token compare (v2, architecture v2 §3.2): flat `!==` leaks the
 * token length via timing; timingSafeEqual on equal-length buffers does not.
 * Length mismatch short-circuits (timingSafeEqual throws on unequal lengths).
 */
function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * One server-log ring-buffer entry (Fix 4): `ts` is epoch ms, `level` is a
 * coarse severity ("info"/"warn"/"error"), `msg` is a single-line human string.
 */
export interface ServerLogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

/** Ring-buffer cap for the /api/logs backlog (oldest dropped first). */
const LOG_CAP = 200;

/** Minimal session-ref shape held by WebServer (re-pointed per session_start). */
export interface SessionRef {
  pi: {
    sendUserMessage(
      content: string | unknown[],
      opts?: { deliverAs?: "steer" | "followUp" }
    ): unknown;
    [k: string]: unknown;
  };
  ctx: {
    abort(): void;
    [k: string]: unknown;
  };
}

/** Inbound command handler seam — set by extensions/webui.ts (Task 3). */
export type CommandHandler = (
  frame: ClientFrame,
  reply: (frame: WebFrame) => void
) => void;

/**
 * Additive HTTP route handler seam — set by extensions/webui.ts via
 * {@link WebServer.setHttpRoutes} (ticket 06 D3). Consulted inside `fetch()`
 * AFTER the origin guard and BEFORE the hardcoded /health,/,/ws branches. The
 * handler returns `null` to fall through. Returns loopback-guarded responses
 * (the origin guard already ran).
 */
export type HttpRouteHandler = (
  req: Request,
  srv: Server<undefined>
) => Response | null;

export interface WebServerOptions {
  /** Requested port; 0 (default) = OS-assigned ephemeral. */
  port?: number;
  /** Bind hostname; default 127.0.0.1 (loopback-only, spec §5). */
  hostname?: string;
}

/**
 * No-routes fallback page (architecture v2 §3.7): opens the WS so the
 * transport is manually provable. In PROD the wiring installs the real render
 * shell at GET / via `setHttpRoutes` (render-routes.ts) BEFORE this branch, so
 * the stub is only reachable when no routes are installed (a bare WebServer /
 * tests). Relabeled from the v1 "ticket 06" connect-test wording.
 */
const STUB_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>webui (not wired)</title></head>
<body>
<pre id="log"></pre>
<script>
const log = document.getElementById('log');
function out(m){ log.textContent += m + '\\n'; }
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
out('[ws] ' + wsUrl);
const ws = new WebSocket(wsUrl);
ws.onopen    = () => out('[open] ' + new Date().toISOString());
ws.onmessage = (e) => out('[frame] ' + e.data);
ws.onclose   = () => out('[close]');
ws.onerror   = () => out('[error]');
</script>
</body>
</html>`;

export class WebServer implements Broadcaster {
  private server: ReturnType<typeof Bun.serve> | null = null;
  // Bun.serve infers the WS handler socket as ServerWebSocket<unknown> (its data
  // defaults to undefined, but the handler type is pinned to <unknown>); keep the
  // client set generic so the inferred socket is assignable as-is.
  private readonly clients = new Set<ServerWebSocket<unknown>>();
  private session: SessionRef | null = null;
  private onCommand: CommandHandler | null = null;
  private httpRoutes: HttpRouteHandler | null = null;
  /** Optional token-auth token (ticket 07 D1); null => NO check (v1 loopback). */
  private token: string | null = null;
  /** Optional WS-close handler (spec Component 1); null => none (the default). */
  private onWsClose: (() => void) | null = null;
  /** Optional WS-open handler (v2 snapshot seam); null => none (the default). */
  private onWsOpen: ((ws: ServerWebSocket<unknown>) => void) | null = null;
  private readonly requestedPort: number;
  private readonly hostname: string;
  /** Bounded in-memory server log (Fix 4) — served at GET /api/logs. */
  private readonly logs: ServerLogEntry[] = [];

  /** True once `.unref()` has been called on the live server handle. */
  unrefed = false;

  constructor(opts: WebServerOptions = {}) {
    this.requestedPort = opts.port ?? 0;
    this.hostname = opts.hostname ?? "127.0.0.1";
  }

  /**
   * Append one entry to the bounded server log (newest-last, cap {@link LOG_CAP}).
   * Pure bookkeeping — never throws, never touches the live server.
   */
  private log(level: ServerLogEntry["level"], msg: string): void {
    this.logs.push({ ts: Date.now(), level, msg });
    if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
  }

  /**
   * Test/debug read access to the server log (newest-last). The HTTP surface
   * is GET /api/logs; this getter keeps tests off private-field casts.
   */
  get serverLogs(): readonly ServerLogEntry[] {
    return this.logs;
  }

  /**
   * Lazy, idempotent start. A second call is a no-op (the server survives). On
   * bind failure across the full port-walk, `serveWithFallback` throws and the
   * server stays stopped (a later `start()` retries).
   */
  start(): void {
    if (this.server) return;
    this.server = this.serveWithFallback(this.requestedPort, this.hostname);
    this.log("info", `webui listening on http://${this.hostname}:${this.server.port ?? 0}`);
    // webui is EMBEDDED in the agent process → the server MUST NOT keep the
    // process alive on its own (unref required). gui-movie-director does NOT
    // unref because it is a FOREGROUND dev server; the inverse is intentional.
    this.server.unref();
    this.unrefed = true;
  }

  /**
   * Re-point the live session (called on each session_start). The stored ref is
   * VESTIGIAL — WebServer only ever reads `hasSession()`; the real dispatch
   * closure (set via setCommandHandler by the wiring) holds the live pi/ctx.
   * Params are widened to unknown so the union call site
   * (`WebuiServer | WebServer`) accepts a narrow host surface; the cast is the
   * single documented narrowing.
   */
  bindSession(pi: unknown, ctx: unknown): void {
    this.session = { pi: pi as SessionRef["pi"], ctx: ctx as SessionRef["ctx"] };
  }

  /** Drop the session ref (session_shutdown). The server STAYS up (spec §6). */
  dropSession(): void {
    this.session = null;
  }

  /** True iff a session is currently bound (Task 3's closure guards on this). */
  hasSession(): boolean {
    return this.session !== null;
  }

  /** Inject the inbound-command handler (extensions/webui.ts sets this). */
  setCommandHandler(cb: CommandHandler | null): void {
    this.onCommand = cb;
  }

  /**
   * Inject additive HTTP routes (ticket 06 D3). `fetch()` consults this handler
   * after the origin guard and before the hardcoded branches; `null` removes it.
   */
  setHttpRoutes(handler: HttpRouteHandler | null): void {
    this.httpRoutes = handler;
  }

  /**
   * Set the OPTIONAL token-auth token (ticket 07 D1). `null` (the default / the
   * v1 loopback wiring) => NO token check — requests pass with only the origin
   * guard. A non-null token requires every request to present it via `?session=`
   * (GET + WS-URL) / `body.token` (POST). Mirrors setHttpRoutes/setCommandHandler.
   */
  setTokenAuth(token: string | null): void {
    this.token = token;
  }

  /**
   * Inject the WS-close abort handler (spec Component 1). Invoked on EVERY ws
   * close so the wiring can resolve all pending HITL presentations as
   * `{cancelled:true}`. `null` removes it. Mirrors setCommandHandler/
   * setHttpRoutes/setTokenAuth.
   */
  setWsCloseHandler(cb: (() => void) | null): void {
    this.onWsClose = cb;
  }

  /**
   * Inject the WS-open handler (v2 snapshot seam, architecture v2 §3.3).
   * Invoked on EVERY ws open with the new socket so the wiring can push a
   * connect-time session snapshot to THAT client before any live frames.
   * `null` removes it. Mirrors setWsCloseHandler.
   */
  setWsOpenHandler(cb: ((ws: ServerWebSocket<unknown>) => void) | null): void {
    this.onWsOpen = cb;
  }

  /** The actual bound port (throws if not started). */
  get port(): number {
    if (!this.server) throw new Error("WebServer not started");
    // Bun types port as `number | undefined` (undefined for unix sockets); we
    // always bind inet so it is a real number — coerce for the type.
    return this.server.port ?? 0;
  }

  /** The `http://` URL the server is reachable on (throws if not started). */
  get url(): string {
    if (!this.server) throw new Error("WebServer not started");
    return `http://${this.hostname}:${this.server.port ?? 0}`;
  }

  /** Current connected-client count (WS pruning is observable for tests). */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Fire-and-forget fan-out to every connected client. A dead/closed socket
   * (per-ws `send` throws) is swallowed and never propagates (spec §6).
   */
  broadcast(frame: WebFrame): void {
    const msg = JSON.stringify(frame);
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        /* socket closed — fire-and-forget, never throw (spec §6) */
      }
    }
  }

  private async fetch(req: Request, srv: Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    // Shared origin guard (spec §2 + v2 hardening, architecture v2 §3.2): the
    // same check gates HTTP fetch AND the WS upgrade (the /ws branch below).
    // v1 only consulted the guard when an Origin was PRESENT — a no-Origin
    // request (curl, scripts, a DNS-rebinding navigation) skipped it entirely,
    // so the Host-hostname validation never ran. v2 calls originAllowed for
    // EVERY request: the Host hostname must be loopback (with or without
    // Origin), and a present Origin must additionally be same-origin. This is
    // the FIRST chokepoint and stays first.
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (!originAllowed(origin, host)) {
      return new Response("forbidden", { status: 403 });
    }
    // Optional token auth (ticket 07 D1): null => NO check. Runs AFTER the
    // origin guard and BEFORE this.httpRoutes. x-webui-token header first, then
    // body.token (POST), then ?session= (legacy). Constant-time compare.
    if (this.token !== null) {
      const presented = await readPresentedToken(req, url);
      if (presented === null || !tokensEqual(presented, this.token))
        return new Response("Forbidden", { status: 403 });
    }
    // GET /api/logs is served DIRECTLY — BEFORE the installed httpRoutes seam —
    // so the log buffer stays viewable even when no routes are installed (or a
    // greedy handler would otherwise shadow it). Pure diagnostics; no-store so
    // a stale log is never cached between debugging rounds.
    if (req.method === "GET" && url.pathname === "/api/logs") {
      return new Response(JSON.stringify(this.logs), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (this.httpRoutes) {
      const res = this.httpRoutes(req, srv);
      if (res) return res;
    }
    if (url.pathname === "/health") {
      return new Response("ok", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/") {
      return new Response(STUB_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/ws") {
      // Origin already checked above; attempt the upgrade.
      if (srv.upgrade(req)) return new Response("WebSocket", { status: 101 });
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Handle one inbound WS text frame: validate -> hand to the `onCommand` seam.
   * Malformed / schema-invalid input is ignored — never crashes, never acquires
   * a lock (spec §6). The no-session guard is NOT here — it is Task 3's closure
   * job (via {@link hasSession}); this adapter never dereferences pi/ctx.
   */
  private onMessage(ws: ServerWebSocket<unknown>, msg: string | Buffer): void {
    let raw: unknown;
    try {
      raw = JSON.parse(typeof msg === "string" ? msg : msg.toString());
    } catch {
      return; // malformed JSON — ignore (spec §6)
    }
    const frame = validateInbound(raw);
    if (!frame) return; // schema-invalid — ignore (spec §6)
    if (this.onCommand) {
      try {
        this.onCommand(frame, (f) => {
          try {
            ws.send(JSON.stringify(f));
          } catch {
            /* socket closed — reply is fire-and-forget */
          }
        });
      } catch (e) {
        // A throwing wiring callback (e.g. sendUserMessage rejecting in the
        // dispatch closure) must never escape the WS message handler — record
        // it in the /api/logs ring instead (architecture v2 §3.2).
        this.log("error", `command handler error: ${(e as Error)?.message ?? String(e)}`);
      }
    }
  }

  /**
   * Build the `Bun.serve` options literal for one bind attempt (Fix 1). Kept as
   * its own method so the idle-timeout decision is directly testable without
   * binding a socket. The fetch/websocket handlers are the live ones — this is
   * the SAME literal `serveWithFallback` passes to `Bun.serve`.
   *
   * `idleTimeout: 0` is load-bearing: Bun's default 10s idle timeout kills
   * idle long-lived connections (SSE /api/events, the /ws upgrade's HTTP leg)
   * and logs "[Bun.serve]: request timed out after 10 seconds" to stderr — and
   * the server runs IN-PROCESS with the pi agent TUI, so that stderr lands in
   * the TUI as a flood (the shell reconnects every 2s → permanent spam). This
   * is a loopback-only, `.unref()`'d embedded server: there is no upstream LB
   * or keep-alive policy to respect, so disabling the idle timeout outright is
   * safe — and HITL-blocking connections (a user staring at a presentation for
   * minutes) must NEVER be idle-killed.
   */
  buildServeOptions(hostname: string, port: number) {
    return {
      hostname,
      port,
      // See the method doc: Bun default 10s = TUI stderr flood (SSE /api/events
      // + WS idle). 0 disables the idle timeout entirely.
      idleTimeout: 0,
      fetch: (req: Request, srv: Server<undefined>) => this.fetch(req, srv),
      websocket: {
        // Same rationale at the WS layer: Bun's WS default (120s idle) would
        // close an idle-but-healthy client → close handler → onWsClose →
        // cancelAllPending for a HITL presentation the user is still deciding
        // on. A silent HITL gate must survive a user thinking for minutes. 0
        // disables it (per-socket setters do not exist on ServerWebSocket in
        // @types/bun 1.3.14; the handler-level option is the available seam).
        idleTimeout: 0,
        open: (ws: ServerWebSocket<unknown>) => {
          this.clients.add(ws);
          this.log("info", `ws open (${this.clients.size} live)`);
          // v2 snapshot seam: the wiring sends the connect-time snapshot to
          // THIS client (before any live frames). A throw here must not kill
          // the socket — record it like the command-handler guard.
          if (this.onWsOpen) {
            try {
              this.onWsOpen(ws);
            } catch (e) {
              this.log("error", `ws open handler error: ${(e as Error)?.message ?? String(e)}`);
            }
          }
        },
        message: (ws: ServerWebSocket<unknown>, msg: string | Buffer) => this.onMessage(ws, msg),
        close: (ws: ServerWebSocket<unknown>) => {
          this.clients.delete(ws);
          this.log("info", `ws close (${this.clients.size} live)`);
          if (this.onWsClose) this.onWsClose();
        },
      },
      // Serve-level error callback (Serve.Options#error): an uncaught fetch
      // error lands here instead of vanishing — recorded in the /api/logs ring.
      error: (err: Error) => {
        this.log("error", `serve error: ${err?.message ?? String(err)}`);
      },
    };
  }

  /**
   * COPIED inline from gui-movie-director/server.ts (NOT a lib export — spec §2).
   * Walks `port..port+50` on EADDRINUSE; throws once the range is exhausted. With
   * port 0 (ephemeral) the first attempt always binds and no walk occurs. The
   * `Bun.serve` config comes from {@link buildServeOptions} (the idle-timeout
   * fix lives there, testable without binding).
   */
  private serveWithFallback(
    port: number,
    hostname: string
  ): ReturnType<typeof Bun.serve> {
    for (let p = port; p <= port + 50; p++) {
      try {
        return Bun.serve(this.buildServeOptions(hostname, p));
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        this.log("warn", `port ${p} busy (${m}); walking to next port`);
        if (!/address|port|EADDRINUSE/i.test(m) || p === port + 50) throw e;
      }
    }
    throw new Error("serveWithFallback: exhausted port range");
  }

  /**
   * Test-only teardown: force-close the server + drop all clients. NOT called on
   * session_shutdown (the server survives; only {@link dropSession} is).
   */
  stop(): void {
    if (this.server) {
      this.log("info", `webui stopped (http://${this.hostname}:${this.server.port ?? 0})`);
      try {
        void this.server.stop(true);
      } catch {
        /* ignore */
      }
    }
    this.server = null;
    this.unrefed = false;
    this.clients.clear();
  }
}
