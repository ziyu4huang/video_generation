import { apiFetch } from "./client";
import type { LoraInfo } from "../hooks/queries/useLoras";

export interface VaeInfo {
  name: string;
  path: string;
}

export function fetchLoras(): Promise<LoraInfo[]> {
  return apiFetch("/api/models/loras");
}

export function fetchVaes(): Promise<VaeInfo[]> {
  return apiFetch("/api/models/vaes");
}
