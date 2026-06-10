import React, { useRef, useEffect, useState } from "react";

interface LogViewerProps {
  logs: string[];
  status?: string;
  onCancel?: () => void;
}

function classifyLine(line: string): string {
  if (line.startsWith("Saved:") || line.includes("Saved:")) return "saved";
  if (line.startsWith("ERROR:") || line.includes("ERROR:")) return "error";
  if (line.startsWith("===") || line.includes("=== Batch")) return "batch";
  if (line.includes("[stderr]")) return "stderr";
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
      <div className="log-viewer" ref={containerRef}>
        {logs.length === 0 ? (
          <span className="log-placeholder">Waiting for output...</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={`log-line ${classifyLine(line)}`}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
