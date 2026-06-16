import { parsePostJson, spawnJobResponse } from "../lib/requestUtils";
import { OUTPUT_DIRS, isPathAllowed } from "../lib/paths";

/**
 * Re-run a previous generation from its `.run.json` by invoking the top-level
 * `run.py replay <runPath>` command.
 *
 * `replay` is a top-level run.py subcommand (sibling of `image`/`video`), so this
 * does NOT go through handleRunJob → actionToCommand (which forces an
 * `image `/`video ` prefix). It spawns `replay` directly. replay rebuilds the run
 * from the structured RunConfig fields — it never reads the legacy `argv` snapshot.
 */
export async function handleReplayJob(req: Request): Promise<Response> {
  const body = await parsePostJson<{ runPath?: string }>(req);
  if (body instanceof Response) return body;
  const { runPath } = body;
  if (!runPath || typeof runPath !== "string") {
    return Response.json({ ok: false, error: "Missing 'runPath'" }, { status: 400 });
  }

  // SECURITY: runPath is passed straight to run.py as a positional arg.
  // subprocess.spawn()'s command-token guard only validates the command string,
  // not the args — so contain runPath to OUTPUT_DIRS exactly like buildCliArgs
  // does for path fields, otherwise a caller could point replay at any file.
  if (!isPathAllowed(runPath, OUTPUT_DIRS)) {
    return Response.json({ ok: false, error: "runPath must be inside an output directory" }, { status: 400 });
  }

  // "replay" is one bare identifier → passes the spawn() token guard. Resulting
  // invocation: <pythonBin> run.py replay <runPath>. The spawned job inherits all
  // existing behavior: stdout parsing for Saved:/Manifest:/Run: surfaces output
  // files, and status flows over WebSocket + /api/jobs SWR.
  return spawnJobResponse("replay", [runPath], { action: "replay", params: { runPath } });
}
