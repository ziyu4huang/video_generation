import React, { useRef, useEffect, useState } from "react";
import s from "./LogViewer.module.css";

interface LogViewerProps {
  logs: string[];
  status?: string;
  onCancel?: () => void;
}

function classifyLine(line: string): string {
  if (line.includes("Saved:") || line.includes("Saved ")) return "saved";
  if (line.includes("ERROR:") || line.includes("Traceback") || line.includes("Error:")) return "error";
  if (line.includes("WARNING:") || line.includes("WARN:") || line.includes("⚠️")) return "warning";
  if (line.startsWith("===") || line.includes("=== Batch")) return "batch";
  if (line.includes("[stderr]")) return "stderr";
  if (/\d+%\s/.test(line) || /\[\d+\/\d+\]/.test(line)) return "progress";
  return "stdout";
}

export function LogViewer({ logs, status, onCancel }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
          {copied ? "Copied!" : "Copy"}
        </button>
        {onCancel && (
          <button className="btn btn-danger" onClick={onCancel} style={{ fontSize: 12, padding: "4px 12px" }}>
            Cancel
          </button>
        )}
      </div>
      <div className={s.logViewer} ref={containerRef}>
        {logs.length === 0 ? (
          <span className={s.logPlaceholder}>Waiting for output...</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={`${s.logLine} ${s[classifyLine(line)] ?? ""}`}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
