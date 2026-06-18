import { apiFetch } from "./client";

export interface AppConfig {
  outputDir: string | string[];
  modelsDir: string;
  vlmApiUrl: string;
  vlmModel: string;
  pythonPath: string;
  deepseekApiKey?: string;
  deepseekModel?: string;
}

export interface VlmTestResult {
  ok: boolean;
  modelLoaded?: boolean;
  models?: string[];
  error?: string;
}

export interface VerifyPythonResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export function getConfig(): Promise<AppConfig> {
  return apiFetch("/api/config");
}

export function putConfig(patch: Partial<AppConfig>): Promise<{ ok: boolean; config: AppConfig }> {
  return apiFetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function verifyPython(pythonPath: string): Promise<VerifyPythonResult> {
  return apiFetch("/api/config/verify-python", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pythonPath }),
  });
}

export function testVlm(): Promise<VlmTestResult> {
  return apiFetch("/api/vlm/test");
}
