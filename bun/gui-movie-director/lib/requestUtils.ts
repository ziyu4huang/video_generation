import { subprocessManager } from "./subprocess";

export async function parsePostJson<T = any>(req: Request): Promise<T | Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    return (await req.json()) as T;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

export function spawnJobResponse(
  command: string,
  cliArgs: string[],
  meta?: { action?: string; params?: Record<string, any> },
): Response {
  const jobId = subprocessManager.spawn(command, cliArgs, meta);
  const job = subprocessManager.getJob(jobId);
  return Response.json({ jobId, status: job?.status, pid: job?.pid });
}
