/**
 * server.ts — flux2 image-generation studio. Bun.serve + SSE (no WebSocket:
 * progress is one-way server→client).
 *
 * Port: --port flag > PORT env > 3123, walking up on conflict so concurrent
 * worktrees never collide. Routes: api/routes.ts (REST + SSE), static index
 * + Bun.build frontend bundle (lib/bundle.ts).
 */
import fs, { readFileSync } from "fs";
import path from "path";

import { handleApi } from "./api/routes";
import { buildFrontendBundle, bundleVersion, serveBundleJs, serveBundleCss } from "./lib/bundle";
import { REPO_DIR } from "./lib/paths";
import { flux2BinExists } from "./lib/paths";

const HOSTNAME = "127.0.0.1";
const PORT = (() => {
  const raw = process.env.PORT;
  const fromEnv = raw ? Number(raw) : undefined;
  return Number.isFinite(fromEnv) && (fromEnv as number) > 0 ? (fromEnv as number) : 3123;
})();

declare global {
  // eslint-disable-next-line no-var
  var __flux2GuiServer: ReturnType<typeof Bun.serve> | undefined;
  // eslint-disable-next-line no-var
  var __flux2GuiInitialized: boolean | undefined;
}

function serveIndex(): Response {
  const html = readFileSync(path.join(REPO_DIR, "bun-apps", "gui-flux2-director", "frontend", "index.html"), "utf8");
  // Inject the bundle version into asset URLs: a rebuilt bundle gets a NEW
  // URL, so even cache-sticky Safari always loads the current CSS/JS.
  const v = bundleVersion();
  const stamped = html
    .replace(/\/bundle\.js\?v=[0-9a-f]*/g, "/bundle.js")
    .replace(/\/bundle\.css\?v=[0-9a-f]*/g, "/bundle.css")
    .replace(/"(\/bundle\.js)"/g, `"$1?v=${v}"`)
    .replace(/"(\/bundle\.css)"/g, `"$1?v=${v}"`);
  return new Response(stamped, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

const serverConfig = {
  hostname: HOSTNAME,
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const apiRes = await handleApi(req);
    if (apiRes !== undefined) return apiRes;

    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return serveIndex();
    if (url.pathname === "/bundle.js") return serveBundleJs(req);
    if (url.pathname === "/bundle.css") return serveBundleCss(req);
    if (url.pathname === "/health") return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    return new Response("Not found", { status: 404 });
  },
  error(err: Error) {
    console.error("Unhandled fetch error:", Bun.inspect(err));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  },
};

/** Bind `port`, walking up to the next free port on collision. */
function serveWithFallback(cfg: typeof serverConfig): ReturnType<typeof Bun.serve> {
  for (let p = cfg.port; p <= cfg.port + 50; p++) {
    try {
      return Bun.serve({ ...cfg, port: p });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/address|port|EADDRINUSE/i.test(msg) || p === cfg.port + 50) throw e;
    }
  }
  throw new Error("serveWithFallback: exhausted port range");
}

if (globalThis.__flux2GuiServer) {
  // --hot reload: swap handlers in place, keep the bound port + connections.
  globalThis.__flux2GuiServer.reload(serverConfig);
} else {
  if (!flux2BinExists()) {
    console.warn(
      `⚠️  flux2 binary not found — build first:\n` +
        `   swift build -c release --package-path swift/flux2-image-director`,
    );
  }
  const built = await buildFrontendBundle();
  if (!built) console.warn("⚠️  frontend bundle failed — / will 503 until a rebuild succeeds");
  // Rebuild the frontend bundle on change — Bun --hot only re-evaluates
  // server modules; frontend edits never trigger anything on their own.
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const frontendDir = path.join(REPO_DIR, "bun-apps", "gui-flux2-director", "frontend");
  try {
    fs.watch(frontendDir, () => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        void buildFrontendBundle().then((ok) => {
          if (ok) console.log("[bundle] rebuilt after frontend change");
        });
      }, 300);
    });
  } catch (err) {
    console.warn("⚠️  frontend watcher failed (edits need a manual restart):", err);
  }
  globalThis.__flux2GuiServer = serveWithFallback(serverConfig);
  globalThis.__flux2GuiInitialized = true;
  console.log(`flux2 director UI → http://${HOSTNAME}:${globalThis.__flux2GuiServer.port}`);
}
