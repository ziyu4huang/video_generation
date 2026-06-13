export interface ConfigData {
  outputDir: string | string[];
  modelsDir: string;
  vlmApiUrl: string;
  vlmModel: string;
  pythonPath: string;
}

export const CONFIG_DEFAULTS: ConfigData = {
  outputDir: "python/mlx-movie-director/output, comfyui_data/output",
  modelsDir: "python/mlx-movie-director/models",
  vlmApiUrl: "http://localhost:1234/v1",
  vlmModel: "qwen/qwen3-vl-4b",
  pythonPath: "",
};

export interface VlmTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  modelLoaded?: boolean;
}

export interface ModelCheckResult {
  ok: boolean;
  total_models?: number;
  total_disk_human?: string;
  error_count?: number;
  warning_count?: number;
  notice_count?: number;
  htmlUrl?: string | null;
  timestamp?: string;
  error?: string;
}
