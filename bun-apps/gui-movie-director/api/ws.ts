import type { Server, ServerWebSocket } from "bun";
import { subprocessManager } from "../lib/subprocess";
import { originAllowed } from "../lib/origin";

export interface WsData {
  subscribedJobId: string | null;
}

const connectedClients = new Set<ServerWebSocket<WsData>>();

export function handleWebSocketUpgrade(req: Request, server: Server<WsData>): boolean {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") return false;

  // WSRF / cross-origin defense: browsers always send an Origin header on the
  // WebSocket handshake. If present, it must be same-origin with this server.
  // A malicious website (Origin: https://evil.com) could otherwise open a socket
  // to localhost:3099 and drive job submission. An absent Origin (curl, scripts,
  // programmatic clients that don't set one) is allowed through.
  //
  // Shared with the HTTP API (api/routes.ts) via lib/origin.ts so a security fix
  // cannot drift between the two sites.
  const origin = req.headers.get("origin");
  if (origin && !originAllowed(origin, req.headers.get("host"))) return false;

  const success = server.upgrade(req, { data: { subscribedJobId: null } });
  return success;
}

export const wsHandlers = {
  open(ws: ServerWebSocket<WsData>) {
    connectedClients.add(ws);
  },

  message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    try {
      const data = JSON.parse(typeof msg === "string" ? msg : msg.toString()) as {
        type?: string;
        jobId?: unknown;
      };
      if (data.type === "subscribe" && typeof data.jobId === "string" && data.jobId) {
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
  // Map job status to a WS message type. A freshly-spawned job broadcasts
  // "running" → job_start so clients revalidate their job list immediately
  // (useJobs listens for it) instead of waiting for the 5s poll. completed →
  // job_complete, anything else (failed) → job_failed.
  const type = job.status === "running" ? "job_start"
             : job.status === "completed" ? "job_complete"
             : "job_failed";
  const message = JSON.stringify({
    type,
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
