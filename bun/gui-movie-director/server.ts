import { handleRequest } from "./api/routes";
import { buildFrontendBundle } from "./api/routes";
import { wsHandlers } from "./api/ws";

const PORT = 3099;

// Build frontend bundle before starting server
await buildFrontendBundle();

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
