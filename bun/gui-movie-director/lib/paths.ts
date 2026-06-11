import fs from "fs";
import path from "path";
import { loadConfig, REPO_DIR } from "./config";

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
    : [path.resolve(REPO_DIR, "python/mlx-movie-director/output")];
}

export const OUTPUT_DIRS = resolveOutputDirs(cfg.outputDir);
/** @deprecated Use OUTPUT_DIRS for multi-directory support */
export const OUTPUT_DIR = OUTPUT_DIRS[0];
/** Fixed mlx output dir — always matches where Python check-model writes its reports */
export const MLX_OUTPUT_DIR = path.resolve(REPO_DIR, "python/mlx-movie-director/output");
export const MODELS_DIR = path.resolve(REPO_DIR, cfg.modelsDir);
export const UPLOAD_DIR = path.join(OUTPUT_DIR, "uploads");
export const FRONTEND_DIR = path.join(REPO_DIR, "bun", "gui-movie-director", "frontend");

export function ensureUploadDir(): void {
  const { mkdirSync } = require("fs");
  mkdirSync(UPLOAD_DIR, { recursive: true });
}
