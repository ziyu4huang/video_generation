import { useState, useCallback, useEffect } from "react";
import { useWebSocket } from "./useWebSocket";
import type { JobInfo } from "../types";

export function useCommandView(command?: string) {
  const [job, setJob] = useState<JobInfo | null>(null);
  const { logs, jobStatus, outputFiles, subscribe } = useWebSocket();

  // Restore last completed/failed job on mount so results survive page reload
  useEffect(() => {
    if (!command) return;
    fetch(`/api/jobs/last?command=${encodeURIComponent(command)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.job) setJob(data.job);
      })
      .catch(() => {});
  }, [command]);

  const handleJobStart = useCallback(
    ({ jobId, command: cmd }: { jobId: string; command: string }) => {
      setJob({
        id: jobId,
        command: cmd,
        status: "running",
        startedAt: new Date().toISOString(),
        outputFiles: [],
        logs: [],
      });
      subscribe(jobId);
    },
    [subscribe]
  );

  const handleCancel = useCallback(async () => {
    if (!job) return;
    try {
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    } catch (err) {
      console.error("Failed to cancel job:", err);
    }
  }, [job]);

  const derivedJob: JobInfo | null = job
    ? {
        ...job,
        status: (jobStatus as JobInfo["status"]) ?? job.status,
        logs: logs.length > 0 ? logs.map((e) => e.line) : job.logs,
        outputFiles: outputFiles.length > 0 ? outputFiles : job.outputFiles,
        completedAt:
          jobStatus === "completed" || jobStatus === "failed"
            ? new Date().toISOString()
            : job.completedAt,
      }
    : null;

  return {
    job: derivedJob,
    loading: derivedJob?.status === "running",
    handleJobStart,
    handleCancel,
  };
}
