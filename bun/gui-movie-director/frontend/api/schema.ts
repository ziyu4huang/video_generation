import type { SelfTestEntry } from "../hooks/queries/useSchemaDefaults";
import { apiFetch } from "./client";

export type ActionDefaults = Record<string, any> & {
  pipeline_steps?: Record<string, number>;
  pipeline_resolution?: Record<string, [number, number]>;
  self_tests?: SelfTestEntry[];
};

export async function fetchSchemaDefaults(): Promise<Record<string, ActionDefaults> | null> {
  const d = await apiFetch<{ ok: boolean; defaults: Record<string, ActionDefaults> }>("/api/schema-defaults");
  return d.ok ? d.defaults : null;
}
