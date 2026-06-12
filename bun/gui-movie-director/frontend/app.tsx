import React, { useState, useCallback } from "react";
import "./styles/global.css";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout";
import { ConfigView } from "./components/ConfigView";
import { DomInspector } from "./components/DomInspector";
import { NavigationContext } from "./context/NavigationContext";
import { GalleryView } from "./views/gallery/GalleryView";
import { JobHistoryView } from "./views/jobs/JobHistoryView";
import { VIEWS, GROUP_ORDER } from "./views";

type View =
  | { type: "gallery"; highlight?: string[] }
  | { type: "config" }
  | { type: "jobs" }
  | { type: "command"; action: string };

export const COMMAND_GROUPS = GROUP_ORDER
  .map((groupLabel) => ({
    label: groupLabel,
    commands: VIEWS
      .filter((v) => v.group === groupLabel)
      .map((v) => ({ id: v.id, label: v.label, icon: v.icon })),
  }))
  .filter((g) => g.commands.length > 0);

export const ALL_COMMANDS = COMMAND_GROUPS.flatMap((g) => g.commands);

const VIEW_MAP: Record<string, React.ComponentType> = Object.fromEntries(
  VIEWS.map((v) => [v.id, v.component])
);

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

  const handleHighlightConsumed = useCallback(() => {
    setView((prev) =>
      prev.type === "gallery" && prev.highlight
        ? { type: "gallery" }
        : prev
    );
  }, []);

  return (
    <NavigationContext.Provider value={(v) => handleViewChange(v as View)}>
      <Layout currentView={view} onViewChange={handleViewChange}>
        {view.type === "gallery" && (
          <GalleryView
            highlight={view.highlight}
            onHighlightConsumed={handleHighlightConsumed}
          />
        )}
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
