import React, { useState, useEffect } from "react";
import { COMMAND_GROUPS } from "../app";
import { useJobs } from "../hooks/useJobs";
import { Tip } from "./Tip";

interface LayoutProps {
  currentView: { type: string; action?: string };
  onViewChange: (view: any) => void;
  children: React.ReactNode;
}

export function Layout({ currentView, onViewChange, children }: LayoutProps) {
  const { jobs } = useJobs();
  const runningJob = jobs.find((j) => j.status === "running") ?? null;
  const failedCount = jobs.filter((j) => j.status === "failed").length;

  // Lightweight WebSocket connection monitor (separate from useWebSocket singleton)
  const [wsConnected, setWsConnected] = useState(true);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let timer: number | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => { setWsConnected(true); if (timer) { clearTimeout(timer); timer = null; } };
      ws.onclose = () => {
        setWsConnected(false);
        timer = window.setTimeout(connect, 5000);
      };
    };
    connect();

    return () => {
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">🎬 Movie Director</div>

        {/* Gallery link */}
        <div className="sidebar-section">
          <div
            className={`sidebar-item ${currentView.type === "gallery" ? "active" : ""}`}
            onClick={() => onViewChange({ type: "gallery" })}
          >
            📷 Gallery
          </div>
          <div
            className={`sidebar-item ${currentView.type === "config" ? "active" : ""}`}
            onClick={() => onViewChange({ type: "config" })}
          >
            ⚙️ Config
          </div>
          <div
            className={`sidebar-item ${currentView.type === "jobs" ? "active" : ""}`}
            onClick={() => onViewChange({ type: "jobs" })}
          >
            📋 Jobs
            {failedCount > 0 && (
              <Tip label={`${failedCount} failed job${failedCount > 1 ? "s" : ""} — click to review`}>
                <span className="sidebar-failed-count">
                  {failedCount} failed
                </span>
              </Tip>
            )}
          </div>
        </div>

        {/* Command groups */}
        {COMMAND_GROUPS.map((group) => (
          <div className="sidebar-section" key={group.label}>
            <div className="sidebar-section-title">{group.label}</div>
            {group.commands.map((cmd) => (
              <div
                key={cmd.id}
                className={`sidebar-item ${currentView.type === "command" && currentView.action === cmd.id ? "active" : ""}`}
                onClick={() => onViewChange({ type: "command", action: cmd.id })}
              >
                <span>{cmd.icon}</span>
                <span>{cmd.label}</span>
              </div>
            ))}
          </div>
        ))}

        {/* Connection status */}
        <div className="sidebar-conn-status">
          <Tip label={wsConnected ? "WebSocket connected" : "WebSocket disconnected — retrying…"}>
            <span className={`conn-dot ${wsConnected ? "ok" : "err"}`} />
          </Tip>
          <span>{wsConnected ? "Connected" : "Disconnected"}</span>
        </div>

        {/* Running job status */}
        {runningJob && (
          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
            <div className="status-badge running">
              <span className="status-dot" />
              {runningJob.command}
            </div>
          </div>
        )}
      </aside>

      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
