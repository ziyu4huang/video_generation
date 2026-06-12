import React, { useState } from "react";
import { useJobs } from "../../hooks/useJobs";
import { useNavigation } from "../../context/NavigationContext";
import { LogViewer } from "../../components/LogViewer";
import type { JobInfo } from "../../types";
import { relativeTime } from "../../utils/format";

interface JobRowProps {
  job: JobInfo;
  expanded: boolean;
  onToggle: () => void;
}

function JobRow({ job, expanded, onToggle }: JobRowProps) {
  const isFailed = job.status === "failed";
  const navigate = useNavigation();
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
        {job.outputFiles.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            🖼 {job.outputFiles.length}
          </span>
        )}
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {relativeTime(job.startedAt)}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 4 }}>
          {expanded ? "▼" : "▶"}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 12px" }}>
          {job.outputFiles.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
              {job.outputFiles.map((fp) => {
                const name = fp.split("/").pop()!;
                return (
                  <img
                    key={name}
                    src={`/output/${name}`}
                    onClick={(e) => { e.stopPropagation(); navigate({ type: "gallery" }); }}
                    alt={name}
                    style={{
                      width: 48,
                      height: 48,
                      objectFit: "cover",
                      borderRadius: "var(--radius)",
                      cursor: "pointer",
                      border: "1px solid var(--border)",
                    }}
                  />
                );
              })}
              <span
                onClick={(e) => { e.stopPropagation(); navigate({ type: "gallery" }); }}
                style={{ fontSize: 12, color: "var(--accent)", cursor: "pointer" }}
              >
                View in Gallery →
              </span>
            </div>
          )}
          {job.logs.length === 0 ? (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No logs captured.</span>
          ) : (
            <LogViewer logs={job.logs} status={job.status} />
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
