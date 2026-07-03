import path from "path";
import { loadConfig, REPO_DIR } from "./config";

// subprocess.ts (and others) import REPO_DIR from "./paths" — re-export the
// binding so it's actually reachable. Importing it above makes it usable in
// this module but does NOT re-export it (ESM bindings aren't implicitly
// forwarded), which left `import { REPO_DIR } from "./paths"` unresolved.
export { REPO_DIR };

export const PYTHON_BIN = path.join(REPO_DIR, "ComfyUI", ".venv", "bin", "python");
export const RUN_PY = path.join(
  REPO_DIR, "python", "mlx-movie-director", "run.py"
);

// Dynamic paths — resolved from config at import time
const cfg = loadConfig();

// Normalize outputDir to always be an array of absolute paths
function resolveOutputDirs(raw: string | string[]): string[] {
  const dirs = Array.isArray(raw) ? raw : [raw];
  const resolved = dirs.filter(Boolean).map((d) => path.resolve(REPO_DIR, d));
  return resolved.length > 0
    ? resolved
    : [path.resolve(REPO_DIR, "../video_generation__output")];
}

export const OUTPUT_DIRS = resolveOutputDirs(cfg.outputDir);
/** @deprecated Use OUTPUT_DIRS for multi-directory support */
export const OUTPUT_DIR = OUTPUT_DIRS[0];
/** Primary mlx output dir — always matches run.py's cfg.OUTPUT_DIR (the first OUTPUT_DIRS entry). */
export const MLX_OUTPUT_DIR = OUTPUT_DIRS[0];
export const MODELS_DIR = path.resolve(REPO_DIR, cfg.modelsDir);
export const UPLOAD_DIR = path.join(OUTPUT_DIR, "uploads");
export const FRONTEND_DIR = path.join(REPO_DIR, "bun", "gui-movie-director", "frontend");

export function ensureUploadDir(): void {
  const { mkdirSync } = require("fs");
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

export function isPathAllowed(filePath: string, allowedDirs: string[] = [...OUTPUT_DIRS, REPO_DIR]): boolean {
  const resolved = path.resolve(filePath);
  return allowedDirs.some((d) => resolved.startsWith(d + path.sep) || resolved === d);
}
