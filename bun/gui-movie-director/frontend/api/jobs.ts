import { apiFetch } from "./client";
import type { JobInfo } from "../types";

export function runJob(action: string, params: Record<string, any>): Promise<{ jobId?: string; error?: string }> {
  return apiFetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
}

export function listJobs(): Promise<{ jobs: JobInfo[] }> {
  return apiFetch("/api/jobs");
}

export function getLastJob(command: string, signal?: AbortSignal): Promise<{ job: JobInfo | null }> {
  return apiFetch(`/api/jobs/last?command=${encodeURIComponent(command)}`, { signal });
}

export function deleteJob(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/jobs/${id}`, { method: "DELETE" });
}

export function clearJobs(status: string): Promise<{ ok: boolean; cleared: number }> {
  return apiFetch(`/api/jobs/all?status=${encodeURIComponent(status)}`, { method: "DELETE" });
}

export function replayJob(runPath: string): Promise<{ jobId?: string; error?: string }> {
  return apiFetch("/api/replay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runPath }),
  });
}
