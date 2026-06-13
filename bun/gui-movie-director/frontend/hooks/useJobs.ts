import { useEffect } from "react";
import useSWR from "swr";
import type { JobInfo } from "../types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useJobs() {
  const { data, mutate } = useSWR<{ jobs: JobInfo[] }>("/api/jobs", fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: false,
  });

  // WebSocket triggers immediate revalidation on job state changes
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "job_complete" || msg.type === "job_failed") mutate();
      } catch { /* ignore */ }
    };
    ws.onerror = () => ws.close();
    return () => ws.close();
  }, [mutate]);

  return { jobs: data?.jobs ?? [], refresh: mutate };
}
