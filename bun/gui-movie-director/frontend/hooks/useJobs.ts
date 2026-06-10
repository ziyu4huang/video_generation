import { useState, useEffect, useCallback } from "react";
import type { JobInfo } from "../app";

export function useJobs() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { jobs, refresh };
}
