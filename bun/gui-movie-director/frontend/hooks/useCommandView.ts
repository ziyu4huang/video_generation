import { useState, useCallback } from "react";
import { useWebSocket } from "./useWebSocket";
import type { JobInfo } from "../types";

export function useCommandView() {
  const [job, setJob] = useState<JobInfo | null>(null);
  const { logs, jobStatus, outputFiles, subscribe } = useWebSocket();

  const handleJobStart = useCallback(
    ({ jobId, command }: { jobId: string; command: string }) => {
      setJob({
        id: jobId,
        command,
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
        logs,
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
