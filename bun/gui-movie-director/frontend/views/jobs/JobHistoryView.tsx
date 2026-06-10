import React, { useState } from "react";
import { useJobs } from "../../hooks/useJobs";
import type { JobInfo } from "../../types";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface JobRowProps {
  job: JobInfo;
  expanded: boolean;
  onToggle: () => void;
}

function JobRow({ job, expanded, onToggle }: JobRowProps) {
  const isFailed = job.status === "failed";
  return (
    <div
      style={{
        borderLeft: isFailed ? "3px solid var(--error)" : "3px solid transparent",
        marginBottom: 8,
        background: "var(--bg-elevated)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span className={`status-badge ${job.status}`}>
          <span className="status-dot" />
          {job.status}
        </span>
        <span style={{ flex: 1, fontSize: 13, color: "var(--text-bright)" }}>
          {job.command}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {relativeTime(job.startedAt)}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 4 }}>
          {expanded ? "▼" : "▶"}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 12px" }}>
          {job.logs.length === 0 ? (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No logs captured.</span>
          ) : (
            <>
              <div
                style={{
                  background: "var(--bg)",
                  borderRadius: "var(--radius)",
                  padding: "10px 12px",
                  maxHeight: 360,
                  overflowY: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 1.6,
                  marginBottom: 8,
                }}
              >
                {job.logs.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      color: line.includes("ERROR") || line.includes("Traceback") || line.includes("Error")
                        ? "var(--error)"
                        : "var(--text)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {line}
                  </div>
                ))}
              </div>
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(job.logs.join("\n"));
                }}
                style={{ fontSize: 12, padding: "4px 12px" }}
              >
                Copy
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function JobHistoryView() {
  const { jobs } = useJobs();
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    // Auto-expand the most recent failed job
    const sorted = [...jobs].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    return sorted.find((j) => j.status === "failed")?.id ?? null;
  });

  const sorted = [...jobs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const failedCount = jobs.filter((j) => j.status === "failed").length;

  return (
    <div style={{ padding: "24px", maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-bright)" }}>
          Job History
        </h2>
        {failedCount > 0 && (
          <span style={{ fontSize: 12, color: "var(--error)" }}>
            {failedCount} failed
          </span>
        )}
        <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: "auto" }}>
          {jobs.length} total
        </span>
      </div>

      {sorted.length === 0 ? (
        <div style={{ color: "var(--text-dim)", fontSize: 14, marginTop: 40, textAlign: "center" }}>
          No jobs yet — run a command to see history here.
        </div>
      ) : (
        sorted.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            expanded={expandedId === job.id}
            onToggle={() => setExpandedId(expandedId === job.id ? null : job.id)}
          />
        ))
      )}
    </div>
  );
}
