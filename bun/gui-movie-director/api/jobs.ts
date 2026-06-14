import { subprocessManager, type Job } from "../lib/subprocess";
import { buildCliArgs, validateParams } from "../lib/args";
import { actionToCommand } from "../lib/actionToCommand";
import { parsePostJson, spawnJobResponse } from "../lib/requestUtils";

export async function handleRunJob(req: Request): Promise<Response> {
  const body = await parsePostJson<{ action?: string; params?: Record<string, any> }>(req);
  if (body instanceof Response) return body;
  const { action, params } = body;
  if (!action || !params) {
    return Response.json({ ok: false, error: "Missing 'action' or 'params'" }, { status: 400 });
  }

  // Derive the command string server-side from the validated `action`.
  // We deliberately ignore any client-supplied `body.command` to prevent a
  // caller from routing to an arbitrary run.py subcommand (e.g. caption,
  // convert, delete). The `action` is already validated against the
  // COMMAND_SCHEMAS registry by validateParams() below, so it is guaranteed
  // to be a known sub-command action when we reach spawn().
  const command = actionToCommand(action);

  // Validate required params
  const errors = validateParams(action, params);
  if (errors.length > 0) {
    return Response.json({ ok: false, error: errors.join("; ") }, { status: 400 });
  }

  // Build CLI args
  let cliArgs: string[];
  try {
    cliArgs = buildCliArgs(action, params);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 400 });
  }

  return spawnJobResponse(command, cliArgs, { action, params });
}

export async function handleListJobs(req: Request): Promise<Response> {
  const jobs = subprocessManager.listJobs();
  return Response.json({ jobs });
}

export async function handleGetJob(req: Request, id: string): Promise<Response> {
  const job = subprocessManager.getJob(id);
  if (!job) {
    return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
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
  const job = subprocessManager.getJob(id);
  if (!job) {
    return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
  }
  // Dual-mode "dismiss this job":
  //  - running  → cancel (terminate child, mark failed, KEEP in history with a
  //               cancel marker). Preserves the existing cancel-flow behavior so
  //               a cancelled run still leaves an audit record.
  //  - finished → remove from history entirely.
  // Without the finished branch, DELETE only ever cancelled running jobs and
  // 404'd for completed/failed ones — so finished jobs were impossible to clear
  // individually (only the bulk /api/jobs/all path worked).
  if (job.status === "running") {
    if (!subprocessManager.killJob(id)) {
      return Response.json({ ok: false, error: "Job not found or not running" }, { status: 404 });
    }
    return Response.json({ ok: true, cancelled: true });
  }
  subprocessManager.deleteJob(id);
  return Response.json({ ok: true, deleted: true });
}

export async function handleClearJobs(req: Request): Promise<Response> {
  if (req.method !== "DELETE") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  const url = new URL(req.url);
  const statuses = (url.searchParams.get("status") ?? "completed,failed")
    .split(",") as Job["status"][];
  const count = subprocessManager.clearJobs(statuses);
  return Response.json({ ok: true, cleared: count });
}
