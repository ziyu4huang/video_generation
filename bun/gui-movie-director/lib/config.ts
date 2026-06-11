import fs from "fs";
import path from "path";

const SELF_DIR = import.meta.dir;
const GUI_DIR = path.dirname(SELF_DIR);
export const REPO_DIR = path.resolve(GUI_DIR, "..", "..");
export const GUI_DIR_ABS = GUI_DIR;
const CONFIG_PATH = path.join(GUI_DIR, "config.json");

export interface AppConfig {
  outputDir: string | string[];   // relative to repo root (single dir or array)
  modelsDir: string;   // relative to repo root
  vlmApiUrl: string;
  vlmModel: string;
  pythonPath: string;  // absolute path to python binary
}

const DEFAULTS: AppConfig = {
  outputDir: ["python/mlx-movie-director/output", "comfyui_data/output"],
  modelsDir: "python/mlx-movie-director/models",
  vlmApiUrl: "http://localhost:1234/v1",
  vlmModel: "qwen/qwen3-vl-4b",
  pythonPath: path.join(REPO_DIR, "python", "venv", "bin", "python"),
};

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      _config = { ...DEFAULTS, ...raw };
    } else {
      _config = { ...DEFAULTS };
      saveConfig(_config);
    }
  } catch {
    _config = { ...DEFAULTS };
  }
  return _config!;
}

export function saveConfig(config: AppConfig): void {
  _config = { ...DEFAULTS, ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2) + "\n");
}
