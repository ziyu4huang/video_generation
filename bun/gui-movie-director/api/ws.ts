import type { Server, ServerWebSocket } from "bun";
import { subprocessManager, type Job } from "../lib/subprocess";

interface WsData {
  subscribedJobId: string | null;
}

const connectedClients = new Set<ServerWebSocket<WsData>>();

export function handleWebSocketUpgrade(req: Request, server: Server): boolean {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") return false;

  const success = server.upgrade(req, { data: { subscribedJobId: null } });
  return success;
}

export const wsHandlers = {
  open(ws: ServerWebSocket<WsData>) {
    connectedClients.add(ws);
    // Send currently running jobs' buffered logs
    const jobs = subprocessManager.listJobs().filter((j) => j.status === "running");
    for (const job of jobs) {
      for (const line of job.logs) {
        ws.send(JSON.stringify({
          type: "log",
          jobId: job.id,
          line,
          stream: "stdout" as const,
        }));
      }
    }
  },

  message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    try {
      const data = JSON.parse(typeof msg === "string" ? msg : msg.toString());
      if (data.type === "subscribe" && data.jobId) {
        ws.data.subscribedJobId = data.jobId;
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
