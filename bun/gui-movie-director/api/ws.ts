import { subprocessManager, type Job } from "../lib/subprocess";

const connectedClients = new Set<any>();

export function handleWebSocketUpgrade(req: Request, server: any): boolean {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") return false;

  const success = server.upgrade(req, { data: { subscribedJobId: null as string | null } });
  return success;
}

export const wsHandlers = {
  open(ws: any) {
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

  message(ws: any, msg: string | Buffer) {
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

  close(ws: any) {
    connectedClients.delete(ws);
  },
};

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
  const message = JSON.stringify({
    type: job.status === "completed" ? "job_complete" : "job_failed",
    jobId: job.id,
    exitCode: job.exitCode,
    outputFiles: job.outputFiles,
    manifestPath: job.manifestPath,
    runPath: job.runPath,
  });
  for (const ws of connectedClients) {
    try { ws.send(message); } catch { /* ws closed */ }
  }
});
