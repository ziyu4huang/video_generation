import React, { useState, useCallback, useEffect } from "react";
import "./styles/global.css";
import { createRoot } from "react-dom/client";
import { Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Toaster } from "sonner";
import * as Tooltip from "@radix-ui/react-tooltip";

import { Layout } from "./components/Layout";
import { ConfigView } from "./components/ConfigView";
import { DomInspector } from "./components/DomInspector";
import { CommandPalette } from "./components/CommandPalette";
import { NavigationContext } from "./context/NavigationContext";
import { GalleryView } from "./views/gallery/GalleryView";
import { JobHistoryView } from "./views/jobs/JobHistoryView";
import { VIEWS, GROUP_ORDER } from "./views";

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

// Parse action from /cmd/:action paths
function parseLocation(loc: string): { type: string; action?: string } {
  const cmd = loc.match(/^\/cmd\/(.+)/);
  if (cmd) return { type: "command", action: cmd[1] };
  if (loc === "/jobs") return { type: "jobs" };
  if (loc === "/config") return { type: "config" };
  return { type: "gallery" };
}

// Pre-seed mountedCommands from initial URL so page-reload preserves the view
function initialMounted(): Set<string> {
  const m = window.location.hash.replace(/^#/, "").match(/^\/cmd\/(.+)/);
  return m ? new Set([m[1]]) : new Set();
}

// Flat list of all commands for CommandPalette
const FLAT_COMMANDS = COMMAND_GROUPS.flatMap((g) =>
  g.commands.map((c) => ({ ...c, group: g.label }))
);

function App() {
  // useLocation() resolves to useHashLocation inside <Router hook={useHashLocation}>
  const [location, setLocation] = useLocation();
  const [mountedCommands, setMountedCommands] = useState<Set<string>>(initialMounted);
  const [highlight, setHighlight] = useState<string[] | undefined>();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const currentView = parseLocation(location);

  // NavigationContext navigate function: navigate(path, highlight?)
  const handleNavigate = useCallback((path: string, hl?: string[]) => {
    if (path.startsWith("/cmd/")) {
      const action = path.slice(5);
      setMountedCommands((prev) => {
        if (prev.has(action)) return prev;
        const next = new Set(prev);
        next.add(action);
        return next;
      });
    }
    setHighlight(path === "/gallery" || path === "/" ? hl : undefined);
    setLocation(path);
  }, [setLocation]);

  // Layout still uses the old object-based onViewChange — adapt here
  const handleViewChange = useCallback((v: { type: string; action?: string }) => {
    if (v.type === "command" && v.action) handleNavigate("/cmd/" + v.action);
    else if (v.type === "jobs") handleNavigate("/jobs");
    else if (v.type === "config") handleNavigate("/config");
    else handleNavigate("/gallery");
  }, [handleNavigate]);

  const handleHighlightConsumed = useCallback(() => setHighlight(undefined), []);

  // Cmd+K / Ctrl+K opens command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <NavigationContext.Provider value={handleNavigate}>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={FLAT_COMMANDS}
        onSelect={handleViewChange}
      />
      <Layout currentView={currentView} onViewChange={handleViewChange}>
        {(currentView.type === "gallery") && (
          <GalleryView
            highlight={highlight}
            onHighlightConsumed={handleHighlightConsumed}
          />
        )}
        {currentView.type === "config" && <ConfigView />}
        {currentView.type === "jobs" && <JobHistoryView />}
        {[...mountedCommands].map((id) => {
          const ViewComp = VIEW_MAP[id];
          if (!ViewComp) return null;
          const isActive = currentView.type === "command" && currentView.action === id;
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
root.render(
  <Tooltip.Provider delayDuration={400}>
    <Router hook={useHashLocation}>
      <App />
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </Router>
  </Tooltip.Provider>
);
