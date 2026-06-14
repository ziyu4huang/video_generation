import React, { useState } from "react";
import { useJobs } from "../../hooks/useJobs";
import { useNavigation } from "../../context/NavigationContext";
import { LogViewer } from "../../components/LogViewer";
import { JsonViewer } from "../../components/JsonViewer";
import type { JobInfo } from "../../types";
import { relativeTime, formatDuration } from "../../utils/format";
import { toast } from "../../utils/toast";

interface JobRowProps {
  job: JobInfo;
  expanded: boolean;
  onToggle: () => void;
}

function JobRow({ job, expanded, onToggle }: JobRowProps) {
  const isFailed = job.status === "failed";
  const isRunning = job.status === "running";
  const navigate = useNavigation();

  const duration =
    job.completedAt && job.startedAt
      ? formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
      : isRunning
      ? "running…"
      : null;

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
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, color: "var(--text-bright)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {job.action ?? job.command}
          </span>
          {job.action && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", display: "block" }}>
              {job.command}
            </span>
          )}
        </span>
        {job.exitCode !== undefined && job.exitCode !== 0 && (
          <span style={{ fontSize: 11, color: "var(--error)", background: "color-mix(in srgb, var(--error) 12%, transparent)", padding: "1px 6px", borderRadius: 4 }}>
            exit {job.exitCode}
          </span>
        )}
        {duration && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{duration}</span>
        )}
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
                    onClick={(e) => { e.stopPropagation(); navigate("/gallery"); }}
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
                onClick={(e) => { e.stopPropagation(); navigate("/gallery"); }}
                style={{ fontSize: 12, color: "var(--accent)", cursor: "pointer" }}
              >
                View in Gallery →
              </span>
            </div>
          )}

          {(job.runPath || job.manifestPath) && (
            <div style={{ display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
              {job.runPath && (
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Run: <span style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>{job.runPath.split("/").pop()}</span>
                </span>
              )}
              {job.manifestPath && (
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Manifest: <span style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>{job.manifestPath.split("/").pop()}</span>
                </span>
              )}
            </div>
          )}

          {job.params && (
            <details style={{ marginBottom: 10 }}>
              <summary style={{ fontSize: 12, color: "var(--text-dim)", cursor: "pointer", marginBottom: 4 }}>
                Params
              </summary>
              <JsonViewer data={job.params} />
            </details>
          )}

          {(job.status === "failed" || job.status === "completed") && job.action && (
            <div style={{ marginBottom: 10 }}>
              <button
                className="btn btn-primary"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const res = await fetch("/api/run", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: job.action, params: job.params ?? {} }),
                    });
                    const data = await res.json();
                    if (data.jobId) {
                      toast.success("Retry started");
                    } else if (data.error) {
                      toast.error(data.error);
                    }
                  } catch (err) {
                    toast.error(`Failed to retry: ${err}`);
                  }
                }}
                style={{ fontSize: 12, padding: "4px 14px" }}
              >
                {job.status === "failed" ? "🔁 Retry" : "🔁 Run Again"}
              </button>
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
  const { jobs, refresh } = useJobs();
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    // Auto-expand the most recent failed job
    const sorted = [...jobs].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    return sorted.find((j) => j.status === "failed")?.id ?? null;
  });
  const [clearing, setClearing] = useState(false);

  const sorted = [...jobs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const doneCount = jobs.filter((j) => j.status !== "running").length;

  const handleClearDone = async () => {
    setClearing(true);
    try {
      await fetch("/api/jobs/all?status=completed,failed", { method: "DELETE" });
      refresh();
    } finally {
      setClearing(false);
    }
  };

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
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {jobs.length} total
        </span>
        {doneCount > 0 && (
          <button
            className="btn btn-secondary"
            onClick={handleClearDone}
            disabled={clearing}
            style={{ marginLeft: "auto", fontSize: 12, padding: "4px 12px" }}
          >
            {clearing ? "Clearing…" : `Clear done (${doneCount})`}
          </button>
        )}
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
