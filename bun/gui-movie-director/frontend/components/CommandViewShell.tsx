import React from "react";
import type { JobInfo } from "../types";
import { LogViewer } from "./LogViewer";
import { JobOutputPreview } from "./JobOutputPreview";
import { InlineError } from "./InlineError";
import { SelfTestButton } from "./SelfTestButton";
import { useNavigation } from "../context/NavigationContext";

interface Props {
  children: React.ReactNode;
  // Form
  onSubmit: (e: React.FormEvent) => void;
  submitLabel: string;
  disabled: boolean;
  loading: boolean;
  // Job state
  job: JobInfo | null;
  handleCancel: () => void;
  // Error
  error: string | null;
  onDismiss: () => void;
  // Optional self-test button
  action?: string;
  handleJobStart?: (info: { jobId: string; command: string; isSelfTest?: boolean }) => void;
}

export function CommandViewShell({
  children, onSubmit, submitLabel, disabled, loading,
  job, handleCancel, error, onDismiss, action, handleJobStart,
}: Props) {
  const navigate = useNavigation();

  const handleGallery = () => {
    const names = (job?.outputFiles ?? [])
      .map((f: string) => f.split("/").pop())
      .filter(Boolean) as string[];
    navigate({ type: "gallery", highlight: names });
  };

  return (
    <>
      <form onSubmit={onSubmit}>
        {children}
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={disabled}>
            {loading ? <><span className="spinner" /> {submitLabel}</> : submitLabel}
          </button>
          {action && handleJobStart && (
            <SelfTestButton action={action} onJobStart={handleJobStart} />
          )}
        </div>
        <InlineError message={error} onDismiss={onDismiss} />
      </form>

      {job?.status === "completed" && (
        <JobOutputPreview job={job} onViewInGallery={handleGallery} />
      )}
      {(job?.logs?.length ?? 0) > 0 && (
        <LogViewer
          logs={job?.logs ?? []}
          status={job?.status}
          onCancel={job?.status === "running" ? handleCancel : undefined}
        />
      )}
    </>
  );
}
