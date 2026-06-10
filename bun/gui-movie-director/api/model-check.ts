import fs from "fs";
import path from "path";
import { loadConfig, REPO_DIR } from "../lib/config";
import { RUN_PY } from "../lib/paths";

export async function handleModelCheckRun(_req: Request): Promise<Response> {
  const cfg = loadConfig();
  const pythonBin = cfg.pythonPath?.trim() || path.join(REPO_DIR, "ComfyUI", ".venv", "bin", "python");

  try {
    const proc = Bun.spawnSync(
      [pythonBin, RUN_PY, "check-model", "--json"],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );

    const stdout = new TextDecoder().decode(proc.stdout).trim();

    // check-model exits with code 1 when validation errors are found,
    // but the JSON output is still valid and contains error details.
    // Try parsing stdout regardless of exit code.
    if (stdout) {
      try {
        const result = JSON.parse(stdout);
        return Response.json({ ok: true, result });
      } catch {
        // stdout wasn't valid JSON — fall through to error
      }
    }

    const stderr = new TextDecoder().decode(proc.stderr).trim();
    return Response.json({ ok: false, error: stderr || "check-model produced no output" });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message || "Failed to run check-model" });
  }
}

export async function handleModelCheckCache(_req: Request): Promise<Response> {
  const cfg = loadConfig();
  const outputDir = path.resolve(REPO_DIR, cfg.outputDir);
  const cachePath = path.join(outputDir, "model-check.json");

  if (!fs.existsSync(cachePath)) {
    return Response.json({ ok: false, error: "No cached result" }, { status: 404 });
  }

  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const result = JSON.parse(raw);
    return Response.json({ ok: true, result });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Failed to read cache: " + (e.message || String(e)) });
  }
}
