import useSWR from "swr";
import { fetchSchemaDefaults, type ActionDefaults } from "../../api/schema";

export type SelfTestEntry = { name: string; desc: string };
export type { ActionDefaults };

export function useSchemaDefaults(action: string): ActionDefaults | null {
  const { data } = useSWR<Record<string, ActionDefaults> | null>(
    "/api/schema-defaults",
    fetchSchemaDefaults,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000, // SPA-wide singleton: all instances share one request
    }
  );
  return data?.[action] ?? null;
}
