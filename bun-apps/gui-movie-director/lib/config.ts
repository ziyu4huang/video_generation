import fs from "fs";
import path from "path";
import { getServerArgs } from "./cli-args";

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
  deepseekApiKey?: string;   // falls back to DEEPSEEK_API_KEY env var
  deepseekModel?: string;    // default: "deepseek-chat"
}

const DEFAULTS: AppConfig = {
  outputDir: ["../video_generation__output", "comfyui_data/output"],
  modelsDir: "mlx-models",
  vlmApiUrl: "http://localhost:1234/v1",
  // "auto" = don't force a model: run.py caption auto-resolves (prefers the heavier
  // Gemma 26B when already loaded in LM Studio, else loads Qwen 4B). Set a concrete
  // model id here only to force it. (caption.py _resolve_model does the detection.)
  vlmModel: "auto",
  pythonPath: path.join(REPO_DIR, "python", "venv", "bin", "python"),
};

/**
 * "auto"/empty vlmModel = let run.py caption pick the VLM (prefer Gemma 26B when
 * already loaded, else Qwen 4B). Callers that build `run.py caption` args should
 * OMIT `--model` in that case (passing --model auto bypasses caption.py's load
 * detection and forces a load of that exact model).
 */
export function vlmModelIsAuto(vlmModel: string | undefined | null): boolean {
  const m = (vlmModel ?? "").trim().toLowerCase();
  return m === "" || m === "auto";
}

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

  // 4-level priority for the PRIMARY output dir: cli arg (--gen-output-dir) >
  // env (MLX_OUTPUT_DIR) > config.json > default. bun spawns run.py with the
  // resolved value passed explicitly via --gen-output-dir (lib/subprocess.ts),
  // so the generator always writes where the GUI watches — no env-inheritance
  // drift. Secondary sources (e.g. comfyui_data/output) are preserved, and
  // repo-relative values resolve against REPO_DIR in lib/paths.ts (absolute
  // values pass through unchanged).
  const overrideDir = getServerArgs().genOutputDir ?? process.env.MLX_OUTPUT_DIR;
  if (overrideDir) {
    const dirs = Array.isArray(_config!.outputDir) ? [..._config!.outputDir] : [_config!.outputDir];
    dirs[0] = overrideDir;
    _config!.outputDir = dirs;
  }

  return _config!;
}

export function saveConfig(config: AppConfig): void {
  _config = { ...DEFAULTS, ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2) + "\n");
}
