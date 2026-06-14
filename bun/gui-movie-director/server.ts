import fs from "fs";
import path from "path";
import { handleRequest, buildFrontendBundle, rebuildFrontendBundle } from "./api/routes";
import { wsHandlers, broadcastMessage } from "./api/ws";
import { subprocessManager } from "./lib/subprocess";
import { FRONTEND_DIR, OUTPUT_DIRS } from "./lib/paths";
import { fetchCliSchema, fetchSchemaDefaults } from "./api/schema";

const PORT = 3099;

// Build frontend bundle before starting server
await buildFrontendBundle();
subprocessManager.loadAndRestoreJobs();
await fetchSchemaDefaults();
await fetchCliSchema();

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: 50 * 1024 * 1024,
  static: {
    "/health": new Response("ok", { headers: { "Content-Type": "text/plain" } }),
  },
  async fetch(req, server) {
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
});

console.log(`🎬 Movie Director UI: http://localhost:${server.port}`);

// --- Dev: file watcher for hot reload ---
let _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let _lastRebuildHash = 0;

fs.watch(FRONTEND_DIR, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  if (!/\.[tj]sx?$/.test(filename) && !filename.endsWith(".css")) return;

  // Debounce: coalesce rapid saves within 200ms
  if (_rebuildTimer) clearTimeout(_rebuildTimer);
  _rebuildTimer = setTimeout(async () => {
    const hash = Date.now();
    if (hash - _lastRebuildHash < 250) return; // suppress duplicate
    _lastRebuildHash = hash;

    const changed = filename;
    console.log(`🔄 ${changed} changed — rebuilding bundle…`);
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
});

// --- Dev: output-dir watcher → push gallery-updated to browser ---
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
