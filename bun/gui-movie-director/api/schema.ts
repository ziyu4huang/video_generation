import path from "path";
import { loadConfig, REPO_DIR } from "../lib/config";
import { RUN_PY } from "../lib/paths";

// Cache of the full run.py CLI contract (from `run.py schema`). The single
// source of truth for accepted flags/types/defaults/choices — the GUI schemas
// are validated against this (see scripts/check-schema.ts) and may eventually
// derive defaults from it at runtime.
let _cache: Record<string, any> | null = null;

export async function fetchCliSchema(): Promise<void> {
  const cfg = loadConfig();
  const pythonBin = cfg.pythonPath?.trim() || path.join(REPO_DIR, "python", "venv", "bin", "python");
  try {
    const proc = Bun.spawnSync(
      [pythonBin, RUN_PY, "schema", "--compact"],
      { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) {
      _cache = JSON.parse(out);
      console.log("📋 CLI schema loaded from run.py");
    } else {
      const err = new TextDecoder().decode(proc.stderr).trim();
      console.warn("⚠️  run.py schema produced no output:", err);
    }
  } catch (e) {
    // Non-fatal: consumers fall back to the GUI's hand-authored schemas.
    console.warn("⚠️  CLI schema unavailable:", e);
  }
}

export function getCliSchema(): Record<string, any> | null {
  return _cache;
}

export async function handleGetCliSchema(_req: Request): Promise<Response> {
  if (_cache) return Response.json({ ok: true, schema: _cache });
  return Response.json({ ok: false, error: "CLI schema not loaded" }, { status: 503 });
}
