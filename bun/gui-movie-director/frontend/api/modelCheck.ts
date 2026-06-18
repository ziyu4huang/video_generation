import { apiFetch } from "./client";

export function runModelCheck(): Promise<{ ok: boolean; result?: any; error?: string }> {
  return apiFetch("/api/model-check/run", { method: "POST" });
}

export function scanModelCheck(): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  return apiFetch("/api/model-check/scan", { method: "POST" });
}

export function getModelCheckCache(): Promise<{ ok: boolean; result?: any; htmlUrl?: string | null }> {
  return apiFetch("/api/model-check/cache");
}
