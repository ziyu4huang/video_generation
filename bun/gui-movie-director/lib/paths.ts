import path from "path";
import { loadConfig, REPO_DIR } from "./config";

export const PYTHON_BIN = path.join(REPO_DIR, "ComfyUI", ".venv", "bin", "python");
export const RUN_PY = path.join(
  REPO_DIR, "python", "mlx-movie-director", "run.py"
);

// Dynamic paths — resolved from config at import time
const cfg = loadConfig();

export const OUTPUT_DIR = path.resolve(REPO_DIR, cfg.outputDir);
export const MODELS_DIR = path.resolve(REPO_DIR, cfg.modelsDir);
export const UPLOAD_DIR = path.join(OUTPUT_DIR, "uploads");
export const FRONTEND_DIR = path.join(REPO_DIR, "bun", "gui-movie-director", "frontend");

export function ensureUploadDir(): void {
  const { mkdirSync } = require("fs");
  mkdirSync(UPLOAD_DIR, { recursive: true });
}
