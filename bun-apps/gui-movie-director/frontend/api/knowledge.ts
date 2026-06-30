import { apiFetch } from "./client";

export function scanKnowledge(): Promise<{ ok: boolean; records?: any[] }> {
  return apiFetch("/api/knowledge/scan");
}

export function captionMissing(params?: Record<string, any>): Promise<{ ok: boolean; logs?: string[] }> {
  return apiFetch("/api/knowledge/caption-missing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
}

export function analyzeKnowledge(params: { minScore: number; maxRecords: number }): Promise<{ ok: boolean; report?: any; error?: string }> {
  return apiFetch("/api/knowledge/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

export function getKnowledgeReport(): Promise<{ ok: boolean; report?: any }> {
  return apiFetch("/api/knowledge/report");
}

export function deleteKnowledgeReport(): Promise<{ ok: boolean }> {
  return apiFetch("/api/knowledge/report", { method: "DELETE" });
}
