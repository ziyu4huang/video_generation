import path from "path";

// Resolve project paths relative to this file's location
const SELF_DIR = import.meta.dir; // .../bun/gui-movie-director/lib
const GUI_DIR = path.dirname(SELF_DIR); // .../bun/gui-movie-director
const REPO_DIR = path.resolve(GUI_DIR, "..", ".."); // .../video_generation

export const PYTHON_BIN = path.join(REPO_DIR, "ComfyUI", ".venv", "bin", "python");
export const RUN_PY = path.join(
  REPO_DIR, "python", "mlx-movie-director", "run.py"
);
export const OUTPUT_DIR = path.join(
  REPO_DIR, "python", "mlx-movie-director", "output"
);
export const MODELS_DIR = path.join(
  REPO_DIR, "python", "mlx-movie-director", "models"
);
export const UPLOAD_DIR = path.join(OUTPUT_DIR, "uploads");
export const FRONTEND_DIR = path.join(GUI_DIR, "frontend");

export function ensureUploadDir(): void {
  const { mkdirSync } = require("fs");
  mkdirSync(UPLOAD_DIR, { recursive: true });
}
