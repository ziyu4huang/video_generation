import fs from "fs";
import path from "path";
import { loadConfig, REPO_DIR } from "../lib/config";
import { RUN_PY, MLX_OUTPUT_DIR, OUTPUT_DIRS } from "../lib/paths";
import { readJsonFile, findLatestReportUrl } from "../lib/fsUtils";
import { subprocessManager } from "../lib/subprocess";
import { resolvePythonBin } from "../lib/pythonBin";

export async function handleModelCheckRun(_req: Request): Promise<Response> {
  const pythonBin = resolvePythonBin();
  const outputDir = MLX_OUTPUT_DIR;

  try {
    const proc = Bun.spawnSync(
      [pythonBin, RUN_PY, "check-model", "--json", "--html"],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );

    const stdout = new TextDecoder().decode(proc.stdout).trim();

    // check-model exits with code 1 when validation errors are found,
    // but the JSON output is still valid and contains error details.
    // Try parsing stdout regardless of exit code.
    if (stdout) {
      try {
        const result = JSON.parse(stdout);

        const mlxDirIdx = OUTPUT_DIRS.indexOf(MLX_OUTPUT_DIR);
        const htmlUrl = findLatestReportUrl(outputDir, "model-report-", mlxDirIdx >= 0 ? mlxDirIdx : undefined);

        return Response.json({ ok: true, result, htmlUrl });
      } catch {
        // stdout wasn't valid JSON — fall through to error
      }
    }

    const stderr = new TextDecoder().decode(proc.stderr).trim();
    // Log server-side detail, return generic message to avoid leaking paths/tracebacks
    console.error("[handleModelCheckRun] check-model failed:", stderr);
    return Response.json({ ok: false, error: "Model check failed — see server logs" }, { status: 500 });
  } catch (e: any) {
    // Log server-side detail, return generic message
    console.error("[handleModelCheckRun] spawn failed:", e.message);
    return Response.json({ ok: false, error: "Failed to run check-model" }, { status: 500 });
  }
}

export async function handleModelCheckCache(_req: Request): Promise<Response> {
  const outputDir = MLX_OUTPUT_DIR;
  const cachePath = path.join(outputDir, "model-check.json");

  if (!fs.existsSync(cachePath)) {
    return Response.json({ ok: false, error: "No cached result" }, { status: 404 });
  }

  try {
    const result = readJsonFile(cachePath);
    if (!result) {
      return Response.json({ ok: false, error: "Failed to read cache" });
    }

    const mlxDirIdx = OUTPUT_DIRS.indexOf(MLX_OUTPUT_DIR);
    const htmlUrl = findLatestReportUrl(outputDir, "model-report-", mlxDirIdx >= 0 ? mlxDirIdx : undefined);

    return Response.json({ ok: true, result, htmlUrl });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Failed to read cache: " + (e.message || String(e)) });
  }
}

/** Async model check — returns job ID for WebSocket streaming. */
export function handleModelCheckScan(_req: Request): Response {
  try {
    const jobId = subprocessManager.spawn("check-model", ["--json", "--html"]);
    return Response.json({ ok: true, jobId });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message || "Failed to start scan" });
  }
}
