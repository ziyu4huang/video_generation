/**
 * render-routes.ts — the additive HTTP adapter over {@link RenderService}
 * (specs/06 D3). Installed via `WebServer.setHttpRoutes(createRenderRoutes(registry))`
 * so the core fetch branches (/health, /, /ws) are untouched (D8 — strictly
 * additive). Every response inherits the existing loopback origin guard (the
 * guard runs before this handler is consulted).
 *
 * Routes:
 *   GET /api/views      -> [{ id, title, mode, updatedAt }]
 *   GET /api/view/:id   -> md: { id, mode, html, title, updatedAt }
 *                          html: { id, mode, content, title, updatedAt }
 *                          absent -> 404
 *   GET /api/events     -> text/event-stream; emits `data:{viewId,updatedAt}`
 *                          on each render(); unsubscribes on client disconnect.
 *   (GET / lives in render-shell.ts / Task 5; everything else -> null fall-through)
 *
 * NOTE on the SSE unsubscribe: the per-stream unsubscribe handle is kept in
 * PER-REQUEST scope (a local `unsubscribe` declared inside the /api/events
 * branch and closed over by `start` + `cancel`). A module-scoped slot would be
 * a bug: with >=2 concurrent SSE clients, client B's `start` would overwrite
 * the shared slot, so client A's disconnect `cancel` would unsubscribe B's
 * listener — leaking A's listener and silencing B. Per-request scope makes each
 * stream's lifecycle independent.
 */
import type { Server } from "bun";
import type { RenderService, RenderView } from "./render-service.js";
import type { WebFrame } from "./protocol.js";
import { buildReportFrame } from "./report-frame.js";
import { renderMarkdown } from "./render-markdown.js";
import { RENDER_SHELL_HTML } from "./render-shell.js";

export type RenderRouteHandler = (
  req: Request,
  srv: Server<undefined>
) => Response | Promise<Response> | null; // tab-views (02): /api/report defers body read (sync fall-through preserved)

/** Options for {@link createRenderRoutes} (mirrors the file's DI style). */
export interface RenderRouteOptions {
  /** tab-views (02): report producer sink — receives validated report frames. */
  onReport?: (frame: Extract<WebFrame, { type: "report" }>) => void;
  /**
   * SSE heartbeat interval in ms for /api/events (Fix 3): Bun.serve's idle
   * timeout (and any intermediate proxy) closes silent streams; a periodic
   * `: ping` comment frame keeps the connection observably alive without
   * emitting a view_update. Default 30s; injectable so tests can use ~20ms.
   */
  heartbeatMs?: number;
}

/** Default SSE heartbeat interval (see {@link RenderRouteOptions.heartbeatMs}). */
const DEFAULT_HEARTBEAT_MS = 30_000;

const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function viewSummary(v: RenderView): { id: string; title: string | null; mode: string; updatedAt: number } {
  return { id: v.id, title: v.title ?? null, mode: v.mode, updatedAt: v.updatedAt };
}

export function createRenderRoutes(
  registry: RenderService,
  opts: RenderRouteOptions = {}
): RenderRouteHandler {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  return (req) => {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/") {
      return new Response(RENDER_SHELL_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && pathname === "/api/views") {
      return json(registry.listViews().map(viewSummary));
    }

    // tab-views (02): report producer — POST /api/report {title, markdown|html, source?}.
    // Localhost agent surface: strict validation (EXACTLY one body mode), size
    // caps, opts-injected sink; the frame rides the normal broadcaster (store
    // append -> replay; md renders DOM-built, html renders sandboxed iframe).
    if (req.method === "POST" && pathname === "/api/report") {
      const sink = opts.onReport;
      if (!sink) return new Response("not found", { status: 404 });
      // Sync-handler CONTRACT (HttpRouteHandler: Response | null; the wiring
      // chain composes routes with ?? — an async handler returns a truthy
      // Promise for EVERY request and breaks fall-through + the WS upgrade
      // seam). Only THIS branch goes async — via the returned promise itself.
      return req.text().then((raw: string): Response => {
        if (raw.length > 16777216) return new Response("payload too large", { status: 413 });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
        // webui-v3 follow-up: validation + frame construction live in
        // report-frame.ts — shared with the in-process webui_report tool so
        // both doors emit identical frames.
        const r = buildReportFrame((body ?? {}) as Record<string, unknown>);
        if (!r.ok) return new Response(r.error, { status: r.status });
        sink(r.frame);
        return json({ ok: true, id: r.frame.id });
      }, (): Response => new Response("bad request", { status: 400 }));
    }

    if (req.method === "GET" && pathname.startsWith("/api/view/")) {
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/api/view/".length));
      } catch {
        // Malformed %-escape (e.g. /api/view/%zz) would throw URIError and
        // 500 via the unguarded httpRoutes seam — uniform 400 instead.
        return new Response("bad request", { status: 400 });
      }
      const view = registry.getView(id);
      if (!view) return new Response("not found", { status: 404 });
      if (view.mode === "html") {
        return json({
          id: view.id,
          mode: view.mode,
          content: view.content,
          title: view.title ?? null,
          updatedAt: view.updatedAt,
          ...(view.controls !== undefined ? { controls: view.controls } : {}),
          ...(view.presentId !== undefined ? { presentId: view.presentId } : {}),
        });
      }
      return json({
        id: view.id,
        mode: view.mode,
        html: renderMarkdown(view.content ?? ""),
        title: view.title ?? null,
        updatedAt: view.updatedAt,
        ...(view.controls !== undefined ? { controls: view.controls } : {}),
        ...(view.presentId !== undefined ? { presentId: view.presentId } : {}),
      });
    }

    if (req.method === "GET" && pathname === "/api/events") {
      // Per-request unsubscribe handle (NOT module-scoped): each /api/events
      // response owns its own ReadableStream and its own slot, so concurrent
      // SSE clients cannot clobber each other's unsubscribe closure.
      let unsubscribe: (() => void) | null = null;
      let closed = false;
      // Per-request heartbeat timer (Fix 3), started in start() and cleared in
      // cancel() alongside unsubscribe — same per-request scope rationale as
      // above (a module-scoped timer would leak / cross streams).
      let beat: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          beat = setInterval(() => {
            if (closed) return;
            try {
              // SSE comment frame — keeps the connection alive, ignored by
              // EventSource parsers (never surfaces as a view_update).
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              closed = true;
              if (beat) clearInterval(beat);
            }
          }, heartbeatMs);
          unsubscribe = registry.subscribe((viewId, updatedAt) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ viewId, updatedAt })}\n\n`)
              );
            } catch {
              closed = true;
              if (beat) clearInterval(beat);
            }
          });
        },
        cancel() {
          closed = true;
          if (beat) {
            clearInterval(beat);
            beat = null;
          }
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return null; // fall through to the WebServer defaults
  };
}
