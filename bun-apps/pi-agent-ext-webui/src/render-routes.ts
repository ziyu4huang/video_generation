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
 *   (GET /api/events was CUT in webui-simplify §3 — view refresh rides the
 *    WS view_update frames broadcast by the wiring's registry subscriber.)
 *   (GET / lives in render-shell.ts / Task 5; everything else -> null fall-through)
 *
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
  /** btw-branch (demo): the BTW tab queue — browser-authored branch questions
   * (webui -> agent; the reverse of ask cards). Injected by wiring with the
   * JSONL-backed store. */
  btw?: BtwStore;
  /** Data tab demo: live pipeline telemetry snapshot. */
  dataSummary?: () => Record<string, string | number>;
  /** btw-branch (loop closure): fires when the browser queues a branch
   * question — the wiring rings the bound TUI session's bell here (the
   * agent learns a question waits WITHOUT polling; mirror of the card bell). */
  onBtwCreate?: (entry: import("./btw-store.js").BtwEntry) => void;
  /** Standalone report reader for GET /api/report/<id>/raw (wiring: session
   *  store lookup — same frames the Report tab replays). */
  getReport?: (id: string) => Extract<WebFrame, { type: "report" }> | undefined;
  /** report-cleanup: remove one report frame (store + mirror); false -> 404. */
  removeReport?: (id: string) => boolean;
  /** report-cleanup: clear every report frame; returns the count removed. */
  clearReports?: () => number;
  // (webui-simplify §3: the SSE heartbeatMs option was removed with the route.)
}

import type { BtwStore } from "./btw-store.js";
import { buildBtwEntry } from "./btw-store.js";

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

    // Standalone report view: GET /api/report/<id>/raw — serves a stored
    // report frame's html as a top-level document with the SAME CSP trust
    // boundary as /files (sandbox allow-scripts allow-downloads): export
    // menus work and the browser provides native edge scrolling. Loopback +
    // origin-guarded like every other route on this chain.
    // report-cleanup: DELETE /api/report/<id> removes one frame; DELETE
    // /api/report clears all. Both are wiring-seamed (store removal + mirror
    // compaction) so a restart stays clean. Method-guarded — never collides
    // with the POST producer or the GET /raw reader.
    if (req.method === "DELETE" && pathname === "/api/report" && opts.clearReports) {
      return json({ ok: true, removed: opts.clearReports() });
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/report/") && opts.removeReport) {
      try {
        const id = decodeURIComponent(pathname.slice("/api/report/".length));
        return opts.removeReport(id) ? json({ ok: true }) : new Response("not found", { status: 404 });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    }

    if (req.method === "GET" && pathname.startsWith("/api/report/") && pathname.endsWith("/raw")) {
      const reader = opts.getReport;
      if (!reader) return new Response("not found", { status: 404 });
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/api/report/".length, pathname.length - "/raw".length));
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const f = reader(id);
      if (!f || typeof f.html !== "string") return new Response("not found", { status: 404 });
      return new Response(f.html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "sandbox allow-scripts allow-downloads",
          "X-Content-Type-Options": "nosniff",
        },
      });
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
      // console-noise fix: the shell probes /api/view/main at boot; an EMPTY
      // main slot is a normal state, but a 404 logs a console error in
      // Chromium and keeps the audit's zero-console-errors invariant red on
      // every clean boot. Answer 204 (no content) for THE main slot only —
      // every other missing id stays a true 404.
      if (!view) {
        if (id === "main") return new Response(null, { status: 204 });
        return new Response("not found", { status: 404 });
      }
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

    // btw-branch (demo): POST /api/btw queues a branch question authored in
    // the browser (optionally seeded with report context); GET /api/btw lists
    // pending; POST /api/btw/<id>/resolve marks one answered (agent or the
    // tab's resolved button). Same async-body contract as POST /api/report.
    if (opts.btw) {
      if (req.method === "GET" && pathname === "/api/btw") {
        return json({ pending: opts.btw.list().filter((e) => !e.resolvedAt) });
      }
      if (req.method === "POST" && pathname === "/api/btw") {
        const store = opts.btw;
        return req.text().then((raw: string): Response => {
          if (raw.length > 16384) return new Response("payload too large", { status: 413 });
          let body: unknown;
          try { body = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
          const r = buildBtwEntry(body);
          if (!r.ok) return new Response(r.error, { status: 400 });
          const e = store.create(r.entry);
          opts.onBtwCreate?.(e);
          return json({ ok: true, id: e.id });
        }, (): Response => new Response("bad request", { status: 400 }));
      }
      if (req.method === "POST" && pathname.startsWith("/api/btw/") && pathname.endsWith("/resolve")) {
        const id = decodeURIComponent(pathname.slice("/api/btw/".length, pathname.length - "/resolve".length));
        return opts.btw.resolve(id) ? json({ ok: true }) : new Response("not found", { status: 404 });
      }
    }
    // Data tab demo: one-glance pipeline telemetry (port, uptime, mirror
    // sizes, pending BTWs). Absent injector -> 404 like any unknown route.
    if (req.method === "GET" && pathname === "/api/data/summary" && opts.dataSummary) {
      return json(opts.dataSummary());
    }

    // webui-simplify §3: GET /api/events (SSE) was CUT — one live transport.
    // View refresh rides the WS frames (view_update, broadcast by the wiring's
    // registry subscriber); the REST content routes below are untouched.

    return null; // fall through to the WebServer defaults
  };
}
