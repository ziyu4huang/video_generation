import React, { useState, useEffect, useRef } from "react";
import { LogViewer } from "../components/LogViewer";
import { CommandForm } from "../components/CommandForm";
import { JobOutputPreview } from "../components/JobOutputPreview";
import { SelfTestButton } from "../components/SelfTestButton";
import { SelfTestResults } from "../components/SelfTestResults";
import { useCommandView } from "../hooks/useCommandView";
import { useNavigation } from "../context/NavigationContext";
import { toast } from "../utils/toast";
import type { CommandSchema } from "../schemas/types";

export function createCommandView(schema: CommandSchema, commandPrefix?: string) {
  return function CommandViewInstance() {
    const command = `${commandPrefix ?? "image"} ${schema.action}`;
    const { job, loading, progress, handleJobStart, handleCancel } = useCommandView(command);
    const navigate = useNavigation();
    const [isSelfTest, setIsSelfTest] = useState(false);
    const prevStatusRef = useRef<string | null>(null);

    useEffect(() => {
      const status = job?.status ?? null;
      const prev = prevStatusRef.current;
      prevStatusRef.current = status;
      if (prev === "running" && status === "completed") toast.success("Generation complete");
      if (prev === "running" && status === "failed") toast.error("Job failed");
    }, [job?.status]);

    const onJobStart = (opts: { jobId: string; command: string; isSelfTest?: boolean }) => {
      setIsSelfTest(!!opts.isSelfTest);
      handleJobStart(opts);
    };

    const handleGallery = () => {
      const names = (job?.outputFiles ?? [])
        .map((f: string) => f.split("/").pop())
        .filter(Boolean) as string[];
      navigate("/gallery", names);
    };

    // Defensive empty-state: if the schema yields no sectioned fields (or a
    // render fails silently upstream), never leave a dead blank panel — mirror
    // CommandViewShell's guidance block so the user isn't stuck unactionably.
    const fieldCount = schema.sections.reduce((n, s) => n + s.fields.length, 0);

    return (
      <>
        {fieldCount === 0 ? (
          <div className="empty-view-state">
            <div className="empty-view-state__icon">📭</div>
            <h3 className="empty-view-state__title">This view has nothing to show</h3>
            <p className="empty-view-state__hint">
              The form failed to render. Try reloading the page, or pick another
              command from the sidebar.
            </p>
          </div>
        ) : (
          <CommandForm
            schema={schema}
            onJobStart={onJobStart}
            loading={loading}
            commandPrefix={commandPrefix}
            extraActions={<SelfTestButton action={schema.action} onJobStart={onJobStart} />}
          />
        )}
        {job?.status === "completed" && isSelfTest && (
          <SelfTestResults job={job} />
        )}
        {job?.status === "completed" && !isSelfTest && (
          <JobOutputPreview
            job={job}
            onViewInGallery={handleGallery}
          />
        )}
        {(job?.logs?.length ?? 0) > 0 && (
          <LogViewer
            logs={job?.logs ?? []}
            status={job?.status}
            progress={progress}
            onCancel={job?.status === "running" ? handleCancel : undefined}
          />
        )}
      </>
    );
  };
}
