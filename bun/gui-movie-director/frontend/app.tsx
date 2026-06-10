import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout";
import { Gallery } from "./components/Gallery";
import { CommandForm } from "./components/CommandForm";
import { LogViewer } from "./components/LogViewer";
import { ImagePreview } from "./components/ImagePreview";

// Available image commands grouped by category
export const COMMAND_GROUPS = [
  {
    label: "Generate",
    commands: [
      { id: "t2i", label: "Text → Image", icon: "🎨" },
      { id: "workflow", label: "Workflow", icon: "🔄" },
    ],
  },
  {
    label: "Transform",
    commands: [
      { id: "i2i", label: "Image → Image", icon: "🖼️" },
      { id: "anime2real", label: "Anime → Real", icon: "🎭" },
      { id: "expansion", label: "Expansion", icon: "↔️" },
    ],
  },
  {
    label: "Edit",
    commands: [
      { id: "faceswap", label: "Face Swap", icon: "👤" },
      { id: "swap", label: "Region Swap", icon: "✂️" },
      { id: "controlnet", label: "ControlNet", icon: "🎯" },
      { id: "angle", label: "Camera Angle", icon: "📐" },
    ],
  },
  {
    label: "Analyze",
    commands: [
      { id: "profile", label: "Character Profile", icon: "📋" },
      { id: "quality", label: "Quality", icon: "📊" },
    ],
  },
];

export const ALL_COMMANDS = COMMAND_GROUPS.flatMap((g) => g.commands);

type View =
  | { type: "gallery" }
  | { type: "command"; action: string };

export interface JobInfo {
  id: string;
  command: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  outputFiles: string[];
  logs: string[];
}

function App() {
  const [view, setView] = useState<View>({ type: "gallery" });
  const [currentJob, setCurrentJob] = useState<JobInfo | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleJobStart = useCallback((job: JobInfo) => {
    setCurrentJob(job);
  }, []);

  const handleJobUpdate = useCallback((job: JobInfo) => {
    setCurrentJob(job);
    // Refresh gallery when job completes
    if (job.status === "completed" || job.status === "failed") {
      setRefreshKey((k) => k + 1);
    }
  }, []);

  const handleCancelJob = useCallback(async () => {
    if (!currentJob) return;
    try {
      await fetch(`/api/jobs/${currentJob.id}`, { method: "DELETE" });
    } catch (err) {
      console.error("Failed to cancel job:", err);
    }
  }, [currentJob]);

  return (
    <>
      <Layout
        currentView={view}
        onViewChange={setView}
        currentJob={currentJob}
      >
        {view.type === "gallery" && (
          <Gallery
            key={refreshKey}
            onImageClick={(url) => setPreviewImage(url)}
          />
        )}
        {view.type === "command" && (
          <>
            <CommandForm
              action={view.action}
              onJobStart={handleJobStart}
              loading={currentJob?.status === "running"}
            />
            {(currentJob?.logs?.length || 0) > 0 && (
              <LogViewer
                logs={currentJob?.logs || []}
                status={currentJob?.status}
                onCancel={currentJob?.status === "running" ? handleCancelJob : undefined}
              />
            )}
          </>
        )}
      </Layout>
      {previewImage && (
        <ImagePreview
          url={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
