import path from "path";
import { loadConfig, REPO_DIR } from "./config";

/**
 * Resolve the Python binary path for running mlx-movie-director scripts.
 *
 * Priority order:
 *   1. User-configurable `pythonPath` from config.json (set via GUI settings)
 *   2. Default venv path: `python/venv/bin/python`
 *
 * All mlx-movie-director scripts (run.py, convert.py) live under
 * `python/mlx-movie-director/` and require the `python/venv/` environment
 * (which has mlx and its dependencies installed). The ComfyUI venv at
 * `ComfyUI/.venv/` is for the ComfyUI script runner only and does NOT have
 * mlx — using it here would cause import errors at runtime.
 */
export function resolvePythonBin(): string {
  const cfg = loadConfig();
  return cfg.pythonPath?.trim() || path.join(REPO_DIR, "python", "venv", "bin", "python");
}
