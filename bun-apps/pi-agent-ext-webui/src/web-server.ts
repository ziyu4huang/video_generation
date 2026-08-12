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
import type { Broadcaster } from "./broadcaster.js";
import type { ClientFrame, WebFrame } from "./protocol.js";
import { validateInbound } from "./protocol.js";

// --- origin guard (COPIED inline from gui-movie-director/lib/origin.ts) ------
// DNS-rebinding-safe loopback Host-header guard, shared identically on HTTP
// fetch and the WS upgrade (spec §2). An absent Origin (curl/scripts) is allowed
// through; a present Origin must be same-origin loopback for the bound port.
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function originAllowed(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // absent Origin (curl/scripts) allowed
  if (!host) return false;
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
 * GET + WS-URL: the ?session= query param; POST: body.token (JSON, read via
 * clone() so a downstream additive route can still read the body). Returns null
 * when absent / unparseable. Only called when this.token !== null.
 */
async function readPresentedToken(req: Request, url: URL): Promise<string | null> {
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
 * Stub connect-test page: opens the WS and `console.log`s received frames (spec
 * §5). Enough to validate the protocol end-to-end manually (Task 3 Step 8); the
 * real frontend is ticket 06.
 */
const STUB_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>webui connect-test</title></head>
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
  private readonly requestedPort: number;
  private readonly hostname: string;

  /** True once `.unref()` has been called on the live server handle. */
  unrefed = false;

  constructor(opts: WebServerOptions = {}) {
    this.requestedPort = opts.port ?? 0;
    this.hostname = opts.hostname ?? "127.0.0.1";
  }

  /**
   * Lazy, idempotent start. A second call is a no-op (the server survives). On
   * bind failure across the full port-walk, `serveWithFallback` throws and the
   * server stays stopped (a later `start()` retries).
   */
  start(): void {
    if (this.server) return;
    this.server = this.serveWithFallback(this.requestedPort, this.hostname);
    // webui is EMBEDDED in the agent process → the server MUST NOT keep the
    // process alive on its own (unref required). gui-movie-director does NOT
    // unref because it is a FOREGROUND dev server; the inverse is intentional.
    this.server.unref();
    this.unrefed = true;
  }

  /** Re-point the live session (called on each session_start). */
  bindSession(pi: SessionRef["pi"], ctx: SessionRef["ctx"]): void {
    this.session = { pi, ctx };
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
    // Shared origin guard (spec §2): the same check gates HTTP fetch AND the WS
    // upgrade (the /ws branch below). Absent Origin is allowed. This is the
    // FIRST chokepoint and stays first.
    const origin = req.headers.get("origin");
    if (origin && !originAllowed(origin, req.headers.get("host"))) {
      return new Response("forbidden", { status: 403 });
    }
    // Optional token auth (ticket 07 D1): null => NO check. Runs AFTER the
    // origin guard and BEFORE this.httpRoutes. ?session= for GET + the WS-URL;
    // body.token (JSON, via clone()) for POST. Flat !==, 403 on mismatch.
    if (this.token !== null) {
      const presented = await readPresentedToken(req, url);
      if (presented !== this.token) return new Response("Forbidden", { status: 403 });
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
      this.onCommand(frame, (f) => {
        try {
          ws.send(JSON.stringify(f));
        } catch {
          /* socket closed — reply is fire-and-forget */
        }
      });
    }
  }

  /**
   * COPIED inline from gui-movie-director/server.ts (NOT a lib export — spec §2).
   * Walks `port..port+50` on EADDRINUSE; throws once the range is exhausted. With
   * port 0 (ephemeral) the first attempt always binds and no walk occurs. The
   * `Bun.serve` config is built as a concrete literal (mirroring the lift source)
   * so its inferred type matches `Serve.Options` directly — no union plumbing.
   */
  private serveWithFallback(
    port: number,
    hostname: string
  ): ReturnType<typeof Bun.serve> {
    for (let p = port; p <= port + 50; p++) {
      try {
        return Bun.serve({
          hostname,
          port: p,
          fetch: (req, srv) => this.fetch(req, srv),
          websocket: {
            open: (ws) => {
              this.clients.add(ws);
            },
            message: (ws, msg) => this.onMessage(ws, msg),
            close: (ws) => {
              this.clients.delete(ws);
            },
          },
        });
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
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
