import { useState, useCallback, useEffect, useRef } from "react";
import { useCommandView } from "./useCommandView";
import { useDefaultState } from "./useDefaultState";
import { toast } from "../../utils/toast";
import { runJob } from "../../api/jobs";

export function useCommandJob(
  action: string,
  command: string,
  stateKey: string,
  fallbackDefaults: Record<string, any>,
) {
  const { job, loading, progress, handleJobStart, handleCancel } = useCommandView(command);
  const { state, setField } = useDefaultState(stateKey, fallbackDefaults);
  const [error, setError] = useState<string | null>(null);
  const prevStatusRef = useRef<string | null>(null);

  // Toast on job completion (only when transitioning from running, not on restored jobs)
  useEffect(() => {
    const status = job?.status ?? null;
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === "running" && status === "completed") toast.success("Generation complete");
    if (prev === "running" && status === "failed") toast.error("Job failed");
  }, [job?.status]);

  const submit = useCallback(
    async (params: Record<string, any>) => {
      setError(null);
      try {
        const data = await runJob(action, params);
        if (data.jobId) {
          handleJobStart({ jobId: data.jobId, command });
          toast.success("Job started");
        } else if (data.error) {
          setError(data.error);
          toast.error(data.error);
        }
      } catch (err) {
        const msg = `Failed to start job: ${err}`;
        setError(msg);
        toast.error(msg);
      }
    },
    [action, command, handleJobStart],
  );

  return { state, setField, job, loading, progress, handleJobStart, handleCancel, submit, error, setError };
}
