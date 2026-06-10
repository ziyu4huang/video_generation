import React, { useState, useEffect, useCallback, useRef } from "react";
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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  // WebSocket connection
  useEffect(() => {
    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "log" && msg.line) {
            setCurrentJob((prev) => {
              if (!prev || prev.id !== msg.jobId) return prev;
              return { ...prev, logs: [...prev.logs, msg.line] };
            });
          }

          if (msg.type === "job_complete") {
            setCurrentJob((prev) => {
              if (!prev || prev.id !== msg.jobId) return prev;
              return {
                ...prev,
                status: "completed",
                outputFiles: msg.outputFiles || prev.outputFiles,
                completedAt: new Date().toISOString(),
              };
            });
            setRefreshKey((k) => k + 1);
          }

          if (msg.type === "job_failed") {
            setCurrentJob((prev) => {
              if (!prev || prev.id !== msg.jobId) return prev;
              return {
                ...prev,
                status: "failed",
                completedAt: new Date().toISOString(),
              };
            });
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        reconnectTimer.current = window.setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  // Subscribe to job when currentJob changes
  useEffect(() => {
    if (currentJob?.id && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", jobId: currentJob.id }));
    }
  }, [currentJob?.id]);

  const handleJobStart = useCallback((job: JobInfo) => {
    setCurrentJob(job);
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
