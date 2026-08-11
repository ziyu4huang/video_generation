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
import { renderMarkdown } from "./render-markdown.js";
import { RENDER_SHELL_HTML } from "./render-shell.js";

export type RenderRouteHandler = (
  req: Request,
  srv: Server<undefined>
) => Response | null;

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

export function createRenderRoutes(registry: RenderService): RenderRouteHandler {
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

    if (req.method === "GET" && pathname.startsWith("/api/view/")) {
      const id = decodeURIComponent(pathname.slice("/api/view/".length));
      const view = registry.getView(id);
      if (!view) return new Response("not found", { status: 404 });
      if (view.mode === "html") {
        return json({
          id: view.id,
          mode: view.mode,
          content: view.content,
          title: view.title ?? null,
          updatedAt: view.updatedAt,
        });
      }
      return json({
        id: view.id,
        mode: view.mode,
        html: renderMarkdown(view.content),
        title: view.title ?? null,
        updatedAt: view.updatedAt,
      });
    }

    if (req.method === "GET" && pathname === "/api/events") {
      // Per-request unsubscribe handle (NOT module-scoped): each /api/events
      // response owns its own ReadableStream and its own slot, so concurrent
      // SSE clients cannot clobber each other's unsubscribe closure.
      let unsubscribe: (() => void) | null = null;
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          unsubscribe = registry.subscribe((viewId, updatedAt) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ viewId, updatedAt })}\n\n`)
              );
            } catch {
              closed = true;
            }
          });
        },
        cancel() {
          closed = true;
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
