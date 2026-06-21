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

    // Security: Path containment must anchor on startsWith(root+path.sep) against an
    // explicit allowlist of real roots. Known venv directories are enumerated below;
    // we do NOT accept arbitrary paths containing "/.venv/" or "/venv/" substrings.
    const allowedRoots = [
      REPO_DIR,
      path.resolve(REPO_DIR, "python", "venv"),      // mlx-movie-director venv (default)
      path.resolve(REPO_DIR, "ComfyUI", ".venv"),     // ComfyUI venv (if exists)
    ];

    // Normalize the resolved path with trailing separator for robust prefix matching
    const normalized = resolved + path.sep;
    const isAllowed = allowedRoots.some(root => {
      const rootNormalized = root + path.sep;
      return normalized.startsWith(rootNormalized);
    });

    if (!isAllowed) return false;
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
    // Validate every value up front: all config keys are strings (or string[] for
    // outputDir), so reject anything else instead of casting an unvalidated
    // Record<string, unknown> straight into AppConfig (the old `as any` path).
    const filtered: Record<string, string | string[]> = {};
    for (const key of allowedKeys) {
      if (!(key in body)) continue;
      const v = body[key];
      if (key === "outputDir") {
        // Accept either a non-empty string or a non-empty array of non-empty strings
        if (typeof v === "string" && v.length > 0) {
          filtered[key] = v;
        } else if (Array.isArray(v) && v.length > 0 && v.every((s: unknown) => typeof s === "string" && (s as string).length > 0)) {
          filtered[key] = v as string[];
        } else {
          return Response.json({ ok: false, error: "outputDir must be a non-empty string or non-empty array of strings" }, { status: 400 });
        }
      } else {
        if (typeof v !== "string" || v.length === 0) {
          return Response.json({ ok: false, error: `${key} must be a non-empty string` }, { status: 400 });
        }
        filtered[key] = v;
      }
    }
    const filteredPythonPath = filtered.pythonPath as string | undefined;
    const filteredVlmApiUrl = filtered.vlmApiUrl as string | undefined;
    if (filteredPythonPath && !validatePythonPath(filteredPythonPath)) {
      return Response.json({ ok: false, error: "Invalid pythonPath" }, { status: 400 });
    }
    if (filteredVlmApiUrl) {
      let parsed: URL;
      try { parsed = new URL(filteredVlmApiUrl); } catch {
        return Response.json({ ok: false, error: "Invalid vlmApiUrl" }, { status: 400 });
      }
      // SSRF guard: vlmApiUrl is server-fetched by /api/vlm/test, so it must
      // not point at cloud-metadata, internal services, or arbitrary hosts.
      // Restrict to http(s) scheme and loopback-only hosts (covers the default
      // LM Studio deployment at http://localhost:1234/v1).
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return Response.json({ ok: false, error: "vlmApiUrl must use http or https" }, { status: 400 });
      }
      const host = parsed.hostname.toLowerCase();
      const allowedHosts = ["localhost", "127.0.0.1", "::1"];
      if (!allowedHosts.includes(host)) {
        return Response.json({ ok: false, error: "vlmApiUrl must resolve to localhost/127.0.0.1/::1" }, { status: 400 });
      }
    }
    // Merge validated overrides onto the current config; saveConfig re-merges
    // DEFAULTS. No unvalidated cast reaches AppConfig.
    const merged: AppConfig = { ...loadConfig(), ...(filtered as Partial<AppConfig>) };
    saveConfig(merged);
    return Response.json({ ok: true, config: loadConfig() });
  } catch {
    return Response.json({ ok: false, error: "Invalid config" }, { status: 400 });
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
      // Log the actual error server-side but don't leak paths/tracebacks to client
      console.error("[handleVerifyPython] MLX import check failed:", err);
      return Response.json({ ok: false, error: "MLX not installed or incompatible" }, { status: 400 });
    }
  } catch (e: any) {
    // Log server-side detail, return generic message to avoid leaking internal paths
    console.error("[handleVerifyPython] Spawn failed:", e.message);
    return Response.json({ ok: false, error: "Failed to execute Python" }, { status: 500 });
  }
}
