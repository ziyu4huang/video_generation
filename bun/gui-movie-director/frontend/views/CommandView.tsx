import React from "react";
import { LogViewer } from "../components/LogViewer";
import { CommandForm } from "../components/CommandForm";
import { JobOutputPreview } from "../components/JobOutputPreview";
import { useCommandView } from "../hooks/useCommandView";
import { useNavigation } from "../context/NavigationContext";
import type { CommandSchema } from "../schemas/types";

export function createCommandView(schema: CommandSchema) {
  return function CommandViewInstance() {
    const { job, loading, handleJobStart, handleCancel } = useCommandView();
    const navigate = useNavigation();

    return (
      <>
        <CommandForm schema={schema} onJobStart={handleJobStart} loading={loading} />
        {job?.status === "completed" && (
          <JobOutputPreview
            job={job}
            onViewInGallery={() => navigate({ type: "gallery" })}
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
