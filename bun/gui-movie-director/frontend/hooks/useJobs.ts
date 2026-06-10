import { useState, useEffect, useCallback } from "react";
import type { JobInfo } from "../types";

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

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "job_complete" || msg.type === "job_failed") refresh();
      } catch { /* ignore */ }
    };
    ws.onerror = () => ws.close();

    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, [refresh]);

  return { jobs, refresh };
}
