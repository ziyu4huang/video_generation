import fs from "fs";
import path from "path";
import { handleRequest, buildFrontendBundle, rebuildFrontendBundle } from "./api/routes";
import { wsHandlers, broadcastMessage } from "./api/ws";
import { subprocessManager } from "./lib/subprocess";
import { FRONTEND_DIR, OUTPUT_DIRS } from "./lib/paths";
import { fetchCliSchema, fetchSchemaDefaults } from "./api/schema";

const PORT = 3099;

// Persist server + init state across --hot reloads so we can swap routes
// without restarting the process or re-running expensive init.
declare global {
  var _devServer: ReturnType<typeof Bun.serve> | undefined;
  var _devInitialized: boolean | undefined;
}

const serverConfig = {
  hostname: "127.0.0.1",
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

  globalThis._devServer = Bun.serve(serverConfig);
  console.log(`🎬 Movie Director UI: http://localhost:${globalThis._devServer.port}`);
}

// File watchers must be registered only once — they survive hot reloads because
// the process never exits. Re-registering would stack duplicate watchers.
if (!globalThis._devInitialized) {
  globalThis._devInitialized = true;

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
