import React, { useRef, useEffect } from "react";
import type { LogLine } from "../types";
import s from "./LogViewer.module.css";
import { toast } from "../utils/toast";

interface LogViewerProps {
  logs: LogLine[];
  status?: string;
  progress?: number | null;
  onCancel?: () => void;
}

function classifyLine(line: LogLine): string {
  if (line.stream === "stderr") return "stderr";
  const t = line.text;
  if (t.includes("Saved:") || t.includes("Saved ")) return "saved";
  if (t.includes("ERROR:") || t.includes("Traceback") || t.includes("Error:")) return "error";
  if (t.includes("WARNING:") || t.includes("WARN:") || t.includes("⚠️")) return "warning";
  if (t.startsWith("===") || t.includes("=== Batch")) return "batch";
  if (/\d+%\s/.test(t) || /\[\d+\/\d+\]/.test(t)) return "progress";
  return "stdout";
}

export function LogViewer({ logs, status, progress, onCancel }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = () => {
    navigator.clipboard.writeText(logs.map((l) => l.text).join("\n"));
    toast.success("Log copied");
  };

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, color: "var(--text-bright)" }}>Output Log</h3>
        {status && (
          <span className={`status-badge ${status}`}>
            <span className="status-dot" />
            {status}
          </span>
        )}
        <button
          className="btn btn-secondary"
          onClick={handleCopy}
          style={{ marginLeft: "auto", fontSize: 12, padding: "4px 12px" }}
        >
          Copy
        </button>
        {onCancel && (
          <button className="btn btn-danger" onClick={onCancel} style={{ fontSize: 12, padding: "4px 12px" }}>
            Cancel
          </button>
        )}
      </div>
      {progress != null && (
        <div className="job-progress-bar">
          <div className="job-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className={s.logViewer} ref={containerRef}>
        {logs.length === 0 ? (
          <span className={s.logPlaceholder}>Waiting for output...</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={`${s.logLine} ${s[classifyLine(line)] ?? ""}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
