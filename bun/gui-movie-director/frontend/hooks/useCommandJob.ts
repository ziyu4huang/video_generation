import { useState, useCallback } from "react";
import { useCommandView } from "./useCommandView";
import { useDefaultState } from "./useDefaultState";

export function useCommandJob(
  action: string,
  command: string,
  stateKey: string,
  fallbackDefaults: Record<string, any>,
) {
  const { job, loading, handleJobStart, handleCancel } = useCommandView(command);
  const { state, setField } = useDefaultState(stateKey, fallbackDefaults);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (params: Record<string, any>) => {
      setError(null);
      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, command, params }),
        });
        const data = await res.json();
        if (data.jobId) {
          handleJobStart({ jobId: data.jobId, command });
        } else if (data.error) {
          setError(data.error);
        }
      } catch (err) {
        setError(`Failed to start job: ${err}`);
      }
    },
    [action, command, handleJobStart],
  );

  return { state, setField, job, loading, handleJobStart, handleCancel, submit, error, setError };
}
