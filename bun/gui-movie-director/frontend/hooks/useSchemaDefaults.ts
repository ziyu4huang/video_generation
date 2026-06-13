import useSWR from "swr";

export type SelfTestEntry = { name: string; desc: string };

type ActionDefaults = Record<string, any> & {
  pipeline_steps?: Record<string, number>;
  self_tests?: SelfTestEntry[];
};

const fetcher = (url: string) =>
  fetch(url)
    .then((r) => r.json())
    .then((d) => (d.ok ? (d.defaults as Record<string, ActionDefaults>) : null));

export function useSchemaDefaults(action: string): ActionDefaults | null {
  const { data } = useSWR<Record<string, ActionDefaults> | null>(
    "/api/schema-defaults",
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000, // SPA-wide singleton: all instances share one request
    }
  );
  return data?.[action] ?? null;
}
