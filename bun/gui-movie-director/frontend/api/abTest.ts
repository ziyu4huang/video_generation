import { apiFetch } from "./client";

export interface AbTestParams {
  a: { url: string };
  b: { url: string };
  intent?: string;
  skipVlm?: boolean;
  userNote?: string;
}

export interface AbTestFeedback {
  schema: string;
  intent: string;
  lever: string;
  pair: Array<{
    role: "A" | "B";
    name: string;
    url: string;
    run_path: string | null;
    manifest_path: string | null;
    transformer: string | null;
    model_format: string | null;
    model_dir: string | null;
    key_params: Record<string, any>;
  }>;
  diff_fields: string[];
  analysis: {
    signal_metrics: Record<string, any>;
    pixel_diff: Record<string, any> | null;
    vlm_scores: Record<string, any> | null;
  };
  verdict: { winner: "A" | "B" | "tie"; rationale: string; user_note: string };
  diff_heatmap_url: string | null;
  action_hints: Record<string, any>;
}

export interface AbTestResult {
  ok: boolean;
  feedback?: AbTestFeedback;
  lever?: string;
  heatmapUrl?: string | null;
  error?: string;
}

/** Run the in-gallery A/B analysis (metrics + pixel diff + optional VLM). */
export function runAbTest(params: AbTestParams): Promise<AbTestResult> {
  return apiFetch("/api/gallery/ab-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}
