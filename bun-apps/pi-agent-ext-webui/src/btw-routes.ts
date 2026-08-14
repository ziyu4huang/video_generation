// bun-apps/pi-agent-ext-webui/src/btw-routes.ts
/**
 * btw-routes.ts — the additive HTTP adapter for the btw side panel
 * (Task 8 of the btw-panel-in-webui effort).
 *
 * Installed at the FRONT of the setHttpRoutes chain (before renderRoutes /
 * outputRoutes) so the two pull endpoints answer first; everything else falls
 * through with null so the existing chain continues unchanged:
 *   GET /api/btw         -> latest BtwThreadState snapshot (pull-then-subscribe, D7)
 *   GET /api/btw/models  -> registry-backed model list for the panel dropdown (D12)
 * The live push path is the `btw` WebFrame broadcast (btw-store's forwarder,
 * Task 7) — these routes only serve the initial pull / reconnect refetch.
 */
import type { HttpRouteHandler } from "./web-server.js";
import type { BtwThreadState } from "./btw-channels.js";

/** Registry-backed model summary fed to the panel's Model dropdown (D12). */
export interface BtwModelSummary {
  provider: string;
  id: string;
  api: string;
}

/** Injected state/registry accessors (mirrors the package's DI style). */
export interface BtwRoutesDeps {
  /** Latest thread snapshot, or null when no btw event has been seen yet. */
  getState(): BtwThreadState | null;
  /** Available models from the host session's model registry. */
  getModels(): BtwModelSummary[];
}

/** Pre-first-event default (mirrors btw-store's EMPTY_STATE shape, D7). */
const EMPTY_STATE: BtwThreadState = {
  messages: [],
  mode: "contextual",
  model: null,
  thinking: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** GET /api/btw (thread snapshot, D7) + GET /api/btw/models (registry list, D12). */
export function createBtwRoutes(deps: BtwRoutesDeps): HttpRouteHandler {
  return (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/btw") {
      return jsonResponse(deps.getState() ?? EMPTY_STATE);
    }
    if (req.method === "GET" && url.pathname === "/api/btw/models") {
      return jsonResponse(deps.getModels());
    }
    return null;
  };
}
