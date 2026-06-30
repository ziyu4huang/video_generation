import { useCallback } from "react";
import useSWR from "swr";
import type { JobInfo } from "../../types";
import { listJobs } from "../../api/jobs";
import { useWebSocketEvents } from "../ui/useWebSocketEvents";

export function useJobs() {
  const { data, mutate } = useSWR<{ jobs: JobInfo[] }>("/api/jobs", listJobs, {
    refreshInterval: 5000,
    revalidateOnFocus: false,
  });

  // Shared WS singleton triggers immediate revalidation on job state changes
  useWebSocketEvents(
    useCallback((msg) => {
      if (msg.type === "job_complete" || msg.type === "job_failed" || msg.type === "job_start") {
        mutate();
      }
    }, [mutate]),
  );

  return { jobs: data?.jobs ?? [], refresh: mutate };
}
