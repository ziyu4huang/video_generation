import React, { useState, useEffect, useRef, useMemo } from "react";
import { useWebSocket } from "../../hooks/useWebSocket";
import { relativeTime } from "../../utils/format";
import { FormSection } from "../FormSection";
// @ts-ignore — CSS modules lack type declarations project-wide
import s from "./styles.module.css";
import type { ModelCheckResult } from "./types";

function outputDirDisplay(v: string | string[]): string {
  return Array.isArray(v) ? v.join(", ") : v;
}

function parseOutputDir(val: string): string | string[] {
  const parts = val.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length === 1 ? parts[0] : parts;
}

function parseCheckResult(data: any): ModelCheckResult | null {
  if (!data.ok || !data.result?.summary) return null;
  const summary = data.result.summary;
  return {
    ok: true,
    total_models: summary.total_models,
    total_disk_human: summary.total_disk_human,
    error_count: summary.error_count,
    warning_count: summary.warning_count,
    notice_count: summary.notice_count,
    htmlUrl: data.htmlUrl ?? null,
    timestamp: data.result.timestamp,
  };
}

interface Props {
  outputDir: string | string[];
  modelsDir: string;
  onUpdate: (key: "outputDir" | "modelsDir", value: string | string[]) => void;
}

export function ConfigPathsSection({ outputDir, modelsDir, onUpdate }: Props) {
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ModelCheckResult | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const { logs, jobStatus, subscribe } = useWebSocket();
  const logPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/model-check/cache")
      .then((r) => r.json())
      .then((data) => {
        const parsed = parseCheckResult(data);
        if (parsed) setCheckResult(parsed);
      })
      .catch(() => { /* no cache yet */ });
  }, []);

  useEffect(() => {
    if (jobStatus === "completed" || jobStatus === "failed") {
      fetch("/api/model-check/cache")
        .then((r) => r.json())
        .then((data) => {
          const parsed = parseCheckResult(data);
          if (parsed) setCheckResult(parsed);
          else setCheckResult({ ok: false, error: "Scan failed — no result cached" });
        })
        .catch((e: any) => {
          setCheckResult({ ok: false, error: e.message || "Failed to fetch result" });
        })
        .finally(() => setChecking(false));
    }
  }, [jobStatus]);

  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [logs]);

  const handleCheckModels = async () => {
    setChecking(true);
    setCheckResult(null);
    setShowLogs(true);
    try {
      const res = await fetch("/api/model-check/scan", { method: "POST" });
      const data = await res.json();
      if (data.ok && data.jobId) {
        subscribe(data.jobId);
      } else {
        setCheckResult({ ok: false, error: data.error || "Scan failed" });
        setChecking(false);
      }
    } catch (e: any) {
      setCheckResult({ ok: false, error: e.message || "Network error" });
      setChecking(false);
    }
  };

  const visibleLogs = useMemo(
    () => logs.filter((l) => l.stream !== "stdout" || !l.line.startsWith("{")),
    [logs],
  );

  const renderCheckSummary = () => {
    if (!checkResult) return null;
    const r = checkResult;
    const parts: string[] = [];
    const statusClass = !r.ok ? "fail"
      : (r.error_count ?? 0) > 0 ? "fail"
      : (r.warning_count ?? 0) > 0 ? "warn"
      : "ok";

    if (r.ok) {
      const icon = (r.error_count ?? 0) > 0 ? "❌" : (r.warning_count ?? 0) > 0 ? "⚠️" : "✅";
      parts.push(`${icon} ${r.total_models} models · ${r.total_disk_human}`);
      if ((r.error_count ?? 0) > 0) parts.push(`${r.error_count} errors`);
      if ((r.warning_count ?? 0) > 0) parts.push(`${r.warning_count} warnings`);
      if ((r.notice_count ?? 0) > 0) parts.push(`${r.notice_count} notices`);
    } else {
      parts.push(`❌ ${r.error}`);
    }

    return (
      <div className={s.mcResultPanel}>
        <div className={s.mcResultHeader}>
          <span className={`vlm-test-badge ${statusClass}`}>{parts.join(" · ")}</span>
          {r.timestamp && (
            <span className={s.mcResultTime}>Last checked: {relativeTime(r.timestamp)}</span>
          )}
        </div>
        {r.ok && r.htmlUrl && (
          <a className={s.mcReportLink} href={r.htmlUrl} target="_blank" rel="noopener noreferrer">
            📄 View Full Report
          </a>
        )}
      </div>
    );
  };

  return (
    <FormSection title="Paths (relative to repo root)">
      <div className="form-row">
        <div className="form-group">
          <label>Output Directory</label>
          <input
            type="text"
            value={outputDirDisplay(outputDir)}
            onChange={(e) => onUpdate("outputDir", parseOutputDir(e.target.value))}
            placeholder="python/mlx-movie-director/output, comfyui_data/output"
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Models Directory</label>
          <input
            type="text"
            value={modelsDir}
            onChange={(e) => onUpdate("modelsDir", e.target.value)}
            placeholder="python/mlx-movie-director/models"
          />
        </div>
      </div>
      <div className="form-row" style={{ alignItems: "center", gap: 12 }}>
        <button
          className="btn btn-secondary"
          onClick={handleCheckModels}
          disabled={checking}
          style={{ whiteSpace: "nowrap" }}
        >
          {checking ? "⏳ Scanning…" : "📦 Check Models"}
        </button>
        {checking && <div className="spinner" style={{ width: 18, height: 18 }} />}
        {visibleLogs.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={() => setShowLogs(!showLogs)}
            style={{ whiteSpace: "nowrap", fontSize: 12, padding: "4px 10px" }}
          >
            {showLogs ? "▸ Hide Log" : `▾ Show Log (${visibleLogs.length})`}
          </button>
        )}
      </div>
      {showLogs && visibleLogs.length > 0 && (
        <div className={s.mcLogPanel} ref={logPanelRef}>
          {visibleLogs.map((l, i) => (
            <div key={i} className={s.mcLogLine}>{l.line}</div>
          ))}
        </div>
      )}
      {renderCheckSummary()}
    </FormSection>
  );
}
