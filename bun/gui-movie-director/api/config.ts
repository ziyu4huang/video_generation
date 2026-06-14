import fs from "fs";
import path from "path";
import { loadConfig, saveConfig, REPO_DIR, type AppConfig } from "../lib/config";

/** Validate that a pythonPath looks like a real Python binary under an allowed directory. */
function validatePythonPath(binPath: string): boolean {
  const base = path.basename(binPath);
  // Must start with "python"
  if (!base.startsWith("python")) return false;
  // Must exist on disk
  try {
    const resolved = path.resolve(binPath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;
    // Must be under REPO_DIR or a known venv
    if (!resolved.startsWith(REPO_DIR) && !resolved.includes("/.venv/") && !resolved.includes("/venv/")) return false;
    return true;
  } catch {
    return false;
  }
}

export async function handleGetConfig(_req: Request): Promise<Response> {
  const config = loadConfig();
  return Response.json(config);
}

export async function handlePutConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const allowedKeys = ["outputDir", "modelsDir", "vlmApiUrl", "vlmModel", "pythonPath"];
    // Validate every value up front: all config keys are strings, so reject
    // anything else instead of casting an unvalidated Record<string, unknown>
    // straight into AppConfig (the old `as any` path).
    const filtered: Record<string, string> = {};
    for (const key of allowedKeys) {
      if (!(key in body)) continue;
      const v = body[key];
      if (typeof v !== "string" || v.length === 0) {
        return Response.json({ error: `${key} must be a non-empty string` }, { status: 400 });
      }
      filtered[key] = v;
    }
    if (filtered.pythonPath && !validatePythonPath(filtered.pythonPath)) {
      return Response.json({ error: "Invalid pythonPath" }, { status: 400 });
    }
    if (filtered.vlmApiUrl) {
      try { new URL(filtered.vlmApiUrl); } catch {
        return Response.json({ error: "Invalid vlmApiUrl" }, { status: 400 });
      }
    }
    // Merge validated overrides onto the current config; saveConfig re-merges
    // DEFAULTS. No unvalidated cast reaches AppConfig.
    const merged: AppConfig = { ...loadConfig(), ...(filtered as Partial<AppConfig>) };
    saveConfig(merged);
    return Response.json({ ok: true, config: loadConfig() });
  } catch (err) {
    return Response.json({ error: "Invalid config" }, { status: 400 });
  }
}

export async function handleVerifyPython(req: Request): Promise<Response> {
  let body: { pythonPath?: string };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const bin = body.pythonPath?.trim();
  if (!bin) return Response.json({ ok: false, error: "pythonPath is required" }, { status: 400 });
  if (!validatePythonPath(bin)) return Response.json({ ok: false, error: "Invalid pythonPath" }, { status: 400 });

  try {
    const proc = Bun.spawnSync([bin, "-c", "import mlx.core as mx; import sys; print(sys.version.split()[0])"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const version = new TextDecoder().decode(proc.stdout).trim();
      return Response.json({ ok: true, version });
    } else {
      const err = new TextDecoder().decode(proc.stderr).trim();
      const short = err.split("\n").pop() ?? err;
      return Response.json({ ok: false, error: short });
    }
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message });
  }
}
