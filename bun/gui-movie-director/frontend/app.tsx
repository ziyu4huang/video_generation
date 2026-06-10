import React, { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout";
import { ConfigView } from "./components/ConfigView";
import { DomInspector } from "./components/DomInspector";
import { NavigationContext } from "./context/NavigationContext";
// gallery
import { GalleryView } from "./views/gallery/GalleryView";
// generate
import { T2iView } from "./views/generate/T2iView";
import { WorkflowView } from "./views/generate/WorkflowView";
// transform
import { I2iView } from "./views/transform/I2iView";
import { Anime2realView } from "./views/transform/Anime2realView";
import { ExpansionView } from "./views/transform/ExpansionView";
// edit
import { FaceswapView } from "./views/edit/FaceswapView";
import { SwapView } from "./views/edit/SwapView";
import { ControlnetView } from "./views/edit/ControlnetView";
import { AngleView } from "./views/edit/AngleView";
// analyze
import { ProfileView } from "./views/analyze/ProfileView";
import { QualityView } from "./views/analyze/QualityView";
// tools
import { ModelCheckView } from "./views/tools/ModelCheckView";
// jobs
import { JobHistoryView } from "./views/jobs/JobHistoryView";

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
  {
    label: "Tools",
    commands: [
      { id: "model-check", label: "Model Check", icon: "📦" },
    ],
  },
];

export const ALL_COMMANDS = COMMAND_GROUPS.flatMap((g) => g.commands);

type View =
  | { type: "gallery" }
  | { type: "config" }
  | { type: "jobs" }
  | { type: "command"; action: string };

const VIEW_MAP: Record<string, React.ComponentType> = {
  t2i: T2iView,
  workflow: WorkflowView,
  i2i: I2iView,
  anime2real: Anime2realView,
  expansion: ExpansionView,
  faceswap: FaceswapView,
  swap: SwapView,
  controlnet: ControlnetView,
  angle: AngleView,
  profile: ProfileView,
  quality: QualityView,
  "model-check": ModelCheckView,
};

function App() {
  const [view, setView] = useState<View>({ type: "gallery" });
  const [mountedCommands, setMountedCommands] = useState<Set<string>>(new Set());

  const handleViewChange = useCallback((v: View) => {
    setView(v);
    if (v.type === "command") {
      setMountedCommands((prev) => {
        if (prev.has(v.action)) return prev;
        const next = new Set(prev);
        next.add(v.action);
        return next;
      });
    }
  }, []);

  return (
    <NavigationContext.Provider value={(v) => handleViewChange(v as View)}>
      <Layout currentView={view} onViewChange={handleViewChange}>
        {view.type === "gallery" && <GalleryView />}
        {view.type === "config" && <ConfigView />}
        {view.type === "jobs" && <JobHistoryView />}
        {[...mountedCommands].map((id) => {
          const ViewComp = VIEW_MAP[id];
          if (!ViewComp) return null;
          const isActive = view.type === "command" && view.action === id;
          return (
            <div key={id} style={{ display: isActive ? undefined : "none" }}>
              <ViewComp />
            </div>
          );
        })}
      </Layout>
      <DomInspector />
    </NavigationContext.Provider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
