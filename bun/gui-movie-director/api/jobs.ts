import { subprocessManager } from "../lib/subprocess";
import type { Job } from "../lib/subprocess";
import { buildCliArgs, validateParams } from "../lib/args";

export async function handleRunJob(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { action?: string; command?: string; params?: Record<string, any> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action, params } = body;
  if (!action || !params) {
    return Response.json({ error: "Missing 'action' or 'params'" }, { status: 400 });
  }

  // Full command string, defaults to "image <action>" for backward compatibility
  const command = body.command ?? `image ${action}`;

  // Validate required params
  const errors = validateParams(action, params);
  if (errors.length > 0) {
    return Response.json({ error: errors.join("; ") }, { status: 400 });
  }

  // Build CLI args
  let cliArgs: string[];
  try {
    cliArgs = buildCliArgs(action, params);
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }

  // Spawn subprocess
  const jobId = subprocessManager.spawn(command, cliArgs, { action, params });
  const job = subprocessManager.getJob(jobId);

  return Response.json({
    jobId,
    status: job?.status,
    pid: job?.pid,
  });
}

export async function handleListJobs(req: Request): Promise<Response> {
  const jobs = subprocessManager.listJobs();
  return Response.json({ jobs });
}

export async function handleGetJob(req: Request, id: string): Promise<Response> {
  const job = subprocessManager.getJob(id);
  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  return Response.json({ job });
}

export async function handleGetLastJob(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const command = url.searchParams.get("command");
  const jobs = subprocessManager.listJobs();
  const last = command
    ? jobs.find((j) => j.command === command && j.status !== "running") ?? null
    : null;
  return Response.json({ job: last });
}

export async function handleDeleteJob(req: Request, id: string): Promise<Response> {
  const ok = subprocessManager.killJob(id);
  if (!ok) {
    return Response.json({ error: "Job not found or not running" }, { status: 404 });
  }
  return Response.json({ ok: true });
}

export async function handleClearJobs(req: Request): Promise<Response> {
  if (req.method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const url = new URL(req.url);
  const statuses = (url.searchParams.get("status") ?? "completed,failed")
    .split(",") as Job["status"][];
  const count = subprocessManager.clearJobs(statuses);
  return Response.json({ ok: true, cleared: count });
}
