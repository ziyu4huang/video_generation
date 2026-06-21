import { apiFetch } from "./client";

export interface CaptionRunParams {
  url?: string;
  image?: string;
  style?: string;
  prompt?: string;
}

export function runCaption(params: CaptionRunParams): Promise<{ ok: boolean; caption?: Record<string, any>; error?: string }> {
  return apiFetch("/api/caption/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

export interface ActiveVlmModel {
  activeModel: string;
  alreadyLoaded: boolean | null;
  forced: boolean;
  loadedModels?: string[];
}

export function getActiveVlmModel(): Promise<ActiveVlmModel> {
  return apiFetch("/api/caption/model");
}
