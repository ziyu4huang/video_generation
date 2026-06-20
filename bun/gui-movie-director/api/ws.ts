import type { Server, ServerWebSocket } from "bun";
import { subprocessManager, type Job } from "../lib/subprocess";

interface WsData {
  subscribedJobId: string | null;
}

const connectedClients = new Set<ServerWebSocket<WsData>>();

export function handleWebSocketUpgrade(req: Request, server: Server): boolean {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") return false;

  // WSRF / cross-origin defense: browsers always send an Origin header on the
  // WebSocket handshake. If present, it must be same-origin with this server.
  // A malicious website (Origin: https://evil.com) could otherwise open a socket
  // to localhost:3099 and drive job submission. An absent Origin (curl, scripts,
  // programmatic clients that don't set one) is allowed through.
  //
  // Security: Use a FIXED allowlist of permitted origins, NOT the request's own
  // Host header (vulnerable to DNS rebinding). The server runs on a dynamic port,
  // so we extract it from the Host header and construct the allowlist.
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    if (!host) return false;

    // Extract port from Host header (IPv6 addresses are bracketed)
    const portMatch = host.match(/:(\d+)$/);
    const port = portMatch ? portMatch[1] : "3099"; // default if missing

    // Fixed allowlist of permitted origins for this port
    const allowedOrigins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ];

    if (!allowedOrigins.includes(origin)) return false;
  }

  const success = server.upgrade(req, { data: { subscribedJobId: null } });
  return success;
}

export const wsHandlers = {
  open(ws: ServerWebSocket<WsData>) {
    connectedClients.add(ws);
  },

  message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    try {
      const data = JSON.parse(typeof msg === "string" ? msg : msg.toString());
      if (data.type === "subscribe" && data.jobId) {
        ws.data.subscribedJobId = data.jobId;
        // Replay buffered logs for the subscribed job only (recovers state across
        // reconnects/page reloads without flooding the client with unrelated jobs).
        const job = subprocessManager.getJob(data.jobId);
        if (job) {
          for (const line of job.logs) {
            ws.send(JSON.stringify({
              type: "log",
              jobId: job.id,
              line: line.text,
              stream: line.stream,
            }));
          }
        }
      }
      if (data.type === "unsubscribe") {
        ws.data.subscribedJobId = null;
      }
    } catch {
      // Ignore malformed messages
    }
  },

  close(ws: ServerWebSocket<WsData>) {
    connectedClients.delete(ws);
  },
};

/** Broadcast a JSON message to all connected WebSocket clients */
export function broadcastMessage(data: Record<string, unknown>) {
  const msg = JSON.stringify(data);
  for (const ws of connectedClients) {
    try { ws.send(msg); } catch { /* ws closed */ }
  }
}

// Subscribe to subprocess events and broadcast to WebSocket clients
subprocessManager.onLog((jobId, line, stream) => {
  const message = JSON.stringify({ type: "log", jobId, line, stream });
  for (const ws of connectedClients) {
    const sub = ws.data?.subscribedJobId;
    if (!sub || sub === jobId) {
      try { ws.send(message); } catch { /* ws closed */ }
    }
  }
});

subprocessManager.onStatus((job) => {
  // Invalidate gallery search index so next search rebuilds with new outputs
  if (job.status === "completed") {
    import("../lib/gallery-index").then((m) => m.invalidateIndex()).catch(() => {});
  }
  const message = JSON.stringify({
    type: job.status === "completed" ? "job_complete" : "job_failed",
    jobId: job.id,
    exitCode: job.exitCode,
    outputFiles: job.outputFiles,
    manifestPath: job.manifestPath,
    runPath: job.runPath,
    selfTestHtmlPath: job.selfTestHtmlPath,
  });
  for (const ws of connectedClients) {
    try { ws.send(message); } catch { /* ws closed */ }
  }
});
