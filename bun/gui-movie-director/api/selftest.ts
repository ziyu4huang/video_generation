import { subprocessManager } from "../lib/subprocess";

/**
 * Run a built-in self-test via `run.py image <action> --self-test [name]`.
 * Reuses the same SubprocessManager infrastructure as regular jobs,
 * so logs and output files stream back via WebSocket automatically.
 */
export async function handleRunSelfTest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { action?: string; test_name?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action, test_name } = body;
  if (!action) {
    return Response.json({ error: "Missing 'action'" }, { status: 400 });
  }
  if (!test_name) {
    return Response.json({ error: "Missing 'test_name'" }, { status: 400 });
  }

  // Determine the command prefix: "image" for image subcommands, "video" for video
  const isVideo = action.startsWith("video-");
  const command = isVideo
    ? `video ${action.replace("video-", "")}`
    : `image ${action}`;

  const cliArgs = ["--self-test", test_name];

  const jobId = subprocessManager.spawn(command, cliArgs);
  const job = subprocessManager.getJob(jobId);

  return Response.json({
    jobId,
    status: job?.status,
    pid: job?.pid,
  });
}
