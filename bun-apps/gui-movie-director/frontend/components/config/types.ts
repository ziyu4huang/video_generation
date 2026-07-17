export interface ConfigData {
  outputDir: string | string[];
  modelsDir: string;
  vlmApiUrl: string;
  vlmModel: string;
  pythonPath: string;
}

export const CONFIG_DEFAULTS: ConfigData = {
  outputDir: "../video_generation__output",
  modelsDir: "python/mlx-movie-director/models",
  vlmApiUrl: "http://localhost:1234/v1",
  vlmModel: "auto",
  pythonPath: "",
};

export interface VlmTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  loadedModels?: string[];
  modelLoaded?: boolean;
  activeModel?: string;
  willLoad?: boolean;
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
