import fs from "fs";
import path from "path";
import { handleRequest, buildFrontendBundle, rebuildFrontendBundle } from "./api/routes";
import { wsHandlers, broadcastMessage } from "./api/ws";
import { subprocessManager } from "./lib/subprocess";
import { FRONTEND_DIR, OUTPUT_DIRS } from "./lib/paths";
import { getServerArgs } from "./lib/cli-args";
import { REPO_DIR } from "./lib/config";
import { resolveDefaultPort, isMainWorktree } from "./lib/worktree";
import { registerServer, unregisterServer } from "./lib/gui-registry";
import { fetchCliSchema, fetchSchemaDefaults } from "./api/schema";

// Port priority: explicit --port > PORT env > per-worktree default. The default
// keeps 3099 for the primary worktree (real .git dir / no-git dist build) and
// derives a stable port for linked git worktrees, so concurrent `bun run dev`
// across worktrees don't collide. The ACTUAL bound port is broadcast to the
// registry (lib/gui-registry.ts) and discovered via `bun run gui:port`. No
// config.json layer — a port change needs a server restart.
const HOSTNAME = "127.0.0.1";
const PORT = (() => {
  const explicit = getServerArgs().port
    ?? (process.env.PORT ? Number(process.env.PORT) : undefined);
  return Number.isFinite(explicit) && (explicit as number) > 0 && (explicit as number) <= 65535
    ? (explicit as number)
    : resolveDefaultPort(REPO_DIR);
})();

// Persist server + init state across --hot reloads so we can swap routes
// without restarting the process or re-running expensive init.
declare global {
  var _devServer: ReturnType<typeof Bun.serve> | undefined;
  var _devInitialized: boolean | undefined;
}

const serverConfig = {
  hostname: HOSTNAME,
  port: PORT,
  maxRequestBodySize: 50 * 1024 * 1024,
  static: {
    "/health": new Response("ok", { headers: { "Content-Type": "text/plain" } }),
  },
  async fetch(req: Request, server: ReturnType<typeof Bun.serve>) {
    const result = await handleRequest(req, server);
    if (result === undefined) {
      return new Response("WebSocket", { status: 101 });
    }
    return result;
  },
  error(err: Error) {
    console.error("Unhandled fetch error:", Bun.inspect(err));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  },
  websocket: {
    perMessageDeflate: true,
    maxPayloadLength: 64 * 1024,
    open: wsHandlers.open,
    message: wsHandlers.message,
    close: wsHandlers.close,
  },
};

// If the chosen port is busy (a hash collision with another worktree, or an
// unrelated process), walk up to the next free port so the server always starts.
// The actual bound port is broadcast to the registry, so `gui:port` still works.
function serveWithFallback(cfg: typeof serverConfig): ReturnType<typeof Bun.serve> {
  const start = cfg.port;
  for (let p = start; p <= start + 50; p++) {
    try {
      return Bun.serve({ ...cfg, port: p });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/address|port|EADDRINUSE/i.test(msg) || p === start + 50) throw e;
    }
  }
  throw new Error("serveWithFallback: exhausted port range");
}

if (globalThis._devServer) {
  // Hot reload: swap fetch/websocket handlers in-place, keep connections alive
  globalThis._devServer.reload(serverConfig);
  console.log("🔥 Hot reload — server routes updated");
} else {
  // First start: run expensive init once
  await buildFrontendBundle();
  subprocessManager.loadAndRestoreJobs();
  await fetchSchemaDefaults();
  await fetchCliSchema();

  globalThis._devServer = serveWithFallback(serverConfig);
  const actualPort = globalThis._devServer.port;
  // Bun.serve's `port` is optional in the type (a unix-socket server has none).
  // Registering `undefined` would put `http://<host>:undefined` in the registry
  // and hand `bun run gui:port` a URL nothing can open, so this fails loudly
  // rather than publishing a broken entry.
  if (actualPort === undefined) {
    throw new Error("Bun.serve returned no port — cannot register this GUI server");
  }
  const url = `http://${HOSTNAME}:${actualPort}`;
  // Broadcast to the shared registry so `bun run gui:port` can identify this
  // worktree's server and distinguish it from others.
  registerServer({
    root: REPO_DIR,
    port: actualPort,
    pid: process.pid,
    hostname: HOSTNAME,
    url,
    startedAt: Date.now(),
  });
  const wtKind = isMainWorktree(REPO_DIR)
    ? "primary worktree"
    : `linked worktree · ${path.basename(REPO_DIR)}`;
  console.log(`🎬 Movie Director UI: ${url}  (${wtKind})`);
  console.log(`   → discover any worktree's port with: bun run gui:port`);
}

// File watchers must be registered only once — they survive hot reloads because
// the process never exits. Re-registering would stack duplicate watchers.
if (!globalThis._devInitialized) {
  globalThis._devInitialized = true;

  // Registry cleanup on shutdown — so `bun run gui:port` doesn't list dead
  // servers. Readers also prune dead pids, so this is best-effort for clean exits.
  const shutdownCleanup = () => {
    try { unregisterServer(REPO_DIR); } catch { /* best-effort */ }
  };
  process.on("SIGINT", () => { shutdownCleanup(); process.exit(0); });
  process.on("SIGTERM", () => { shutdownCleanup(); process.exit(0); });
  process.on("exit", shutdownCleanup);

  const SCHEMAS_DIR = path.join(path.dirname(FRONTEND_DIR), "schemas");

  let _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let _lastRebuildHash = 0;

  function onFileChange(_event: string, filename: string | null) {
    if (!filename) return;
    if (!/\.[tj]sx?$/.test(filename) && !filename.endsWith(".css")) return;

    if (_rebuildTimer) clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(async () => {
      const hash = Date.now();
      if (hash - _lastRebuildHash < 250) return;
      _lastRebuildHash = hash;

      console.log(`🔄 ${filename} changed — rebuilding bundle…`);
      const t0 = Bun.nanoseconds();
      const ok = await rebuildFrontendBundle();
      const ms = ((Bun.nanoseconds() - t0) / 1_000_000).toFixed(1);
      if (ok) {
        broadcastMessage({ type: "hmr-reload" });
        console.log(`✅ Rebuilt in ${ms}ms — browser will reload`);
      } else {
        console.log(`❌ Build failed after ${ms}ms`);
      }
    }, 200);
  }

  fs.watch(FRONTEND_DIR, { recursive: true }, onFileChange);
  fs.watch(SCHEMAS_DIR, { recursive: true }, onFileChange);

  // Output-dir watcher → push gallery-updated to browser
  const MEDIA_EXTS = new Set([".png", ".jpg", ".jpeg", ".mp4", ".mov", ".webm", ".m4v"]);
  let _galleryTimer: ReturnType<typeof setTimeout> | null = null;
  for (const dir of OUTPUT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    fs.watch(dir, (_event, filename) => {
      if (!filename) return;
      if (!MEDIA_EXTS.has(path.extname(filename).toLowerCase())) return;
      if (_galleryTimer) clearTimeout(_galleryTimer);
      _galleryTimer = setTimeout(() => {
        import("./lib/gallery-index").then((m) => m.invalidateIndex()).catch(() => {});
        broadcastMessage({ type: "gallery-updated" });
      }, 1500);
    });
  }
}
