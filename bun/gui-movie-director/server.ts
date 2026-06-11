import fs from "fs";
import { handleRequest, buildFrontendBundle, rebuildFrontendBundle } from "./api/routes";
import { wsHandlers, broadcastMessage } from "./api/ws";
import { subprocessManager } from "./lib/subprocess";
import { FRONTEND_DIR } from "./lib/paths";
import { fetchSchemaDefaults } from "./api/schema-defaults";

const PORT = 3099;

// Build frontend bundle before starting server
await buildFrontendBundle();
subprocessManager.loadAndRestoreJobs();
await fetchSchemaDefaults();

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const result = await handleRequest(req, server);
    if (result === undefined) {
      return new Response("WebSocket", { status: 101 });
    }
    return result;
  },
  websocket: {
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
    const ok = await rebuildFrontendBundle();
    if (ok) {
      broadcastMessage({ type: "hmr-reload" });
      console.log("✅ Bundle rebuilt — browser will reload");
    } else {
      console.log("❌ Bundle rebuild failed");
    }
  }, 200);
});
