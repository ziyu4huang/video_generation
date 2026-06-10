import React from "react";
import { COMMAND_GROUPS } from "../app";
import { useJobs } from "../hooks/useJobs";

interface LayoutProps {
  currentView: { type: string; action?: string };
  onViewChange: (view: any) => void;
  children: React.ReactNode;
}

export function Layout({ currentView, onViewChange, children }: LayoutProps) {
  const { jobs } = useJobs();
  const runningJob = jobs.find((j) => j.status === "running") ?? null;
  const failedCount = jobs.filter((j) => j.status === "failed").length;

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
              <span style={{ marginLeft: "auto", color: "var(--error)", fontSize: 11, fontWeight: 600 }}>
                {failedCount} failed
              </span>
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

        {/* Job status at bottom */}
        {runningJob && (
          <div style={{ marginTop: "auto", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
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
