import React, { useState } from "react";
import { LogViewer } from "../components/LogViewer";
import { CommandForm } from "../components/CommandForm";
import { JobOutputPreview } from "../components/JobOutputPreview";
import { SelfTestButton } from "../components/SelfTestButton";
import { SelfTestResults } from "../components/SelfTestResults";
import { useCommandView } from "../hooks/useCommandView";
import { useNavigation } from "../context/NavigationContext";
import type { CommandSchema } from "../schemas/types";

export function createCommandView(schema: CommandSchema, commandPrefix?: string) {
  return function CommandViewInstance() {
    const command = `${commandPrefix ?? "image"} ${schema.action}`;
    const { job, loading, handleJobStart, handleCancel } = useCommandView(command);
    const navigate = useNavigation();
    const [isSelfTest, setIsSelfTest] = useState(false);

    const onJobStart = (opts: { jobId: string; command: string; isSelfTest?: boolean }) => {
      setIsSelfTest(!!opts.isSelfTest);
      handleJobStart(opts);
    };

    const handleGallery = () => {
      const names = (job?.outputFiles ?? [])
        .map((f: string) => f.split("/").pop())
        .filter(Boolean) as string[];
      navigate({ type: "gallery", highlight: names });
    };

    return (
      <>
        <CommandForm schema={schema} onJobStart={onJobStart} loading={loading} commandPrefix={commandPrefix} />
        <div className="btn-row" style={{ marginTop: -8 }}>
          <SelfTestButton action={schema.action} onJobStart={onJobStart} />
        </div>
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
            onCancel={job?.status === "running" ? handleCancel : undefined}
          />
        )}
      </>
    );
  };
}
