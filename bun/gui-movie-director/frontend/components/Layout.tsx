import React from "react";
import { COMMAND_GROUPS, ALL_COMMANDS, type JobInfo } from "../app";

interface LayoutProps {
  currentView: { type: string; action?: string };
  onViewChange: (view: any) => void;
  currentJob: JobInfo | null;
  children: React.ReactNode;
}

export function Layout({ currentView, onViewChange, currentJob, children }: LayoutProps) {
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
        {currentJob && (
          <div style={{ marginTop: "auto", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
            <div className="status-badge running">
              <span className="status-dot" />
              {currentJob.command}
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
