import React, { useState, useEffect } from "react";
import type { ViewDescriptor } from "../registry";
import { relativeTime } from "../../utils/format";
import type { ModelCheckResult } from "../../components/model-check/types";
import { SummaryBadge } from "../../components/model-check/SummaryBadge";
import { DiskUsageBars } from "../../components/model-check/DiskUsageBars";
import { ModelRow } from "../../components/model-check/ModelRow";
import { ConversionSection } from "../../components/model-check/ConversionSection";
import { OrphanSection } from "../../components/model-check/OrphanSection";

export function ModelCheckView() {
  const [result, setResult] = useState<ModelCheckResult | null>(null);
  const [running, setRunning] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/model-check/cache")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) { setResult(data.result); setFromCache(true); }
      })
      .catch(() => { /* no cache yet */ });
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setFromCache(false);
    setExpandedLabel(null);
    try {
      const res = await fetch("/api/model-check/run", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setResult(data.result);
      } else {
        setError(data.error || "Check failed");
      }
    } catch (e: any) {
      setError(e.message || "Network error");
    }
    setRunning(false);
  };

  const filteredModels = result
    ? result.models.filter((m) => {
        if (filterCategory && m.category !== filterCategory) return false;
        if (filterStatus && m.status !== filterStatus) return false;
        return true;
      })
    : [];

  const categories = result
    ? [...new Set(result.models.map((m) => m.category))].sort()
    : [];

  return (
    <div style={{ maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-bright)", margin: 0 }}>
          📦 Model Check
        </h2>
        {result && fromCache && (
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Last checked {relativeTime(result.timestamp)}
          </span>
        )}
      </div>

      {/* Action bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={running}
          style={{ whiteSpace: "nowrap" }}
        >
          {running ? "⏳ Scanning models…" : "🔍 Run Model Check"}
        </button>
        {running && <div className="spinner" style={{ width: 20, height: 20 }} />}
        {error && (
          <span className="vlm-test-badge fail">❌ {error}</span>
        )}
      </div>

      {result && (
        <>
          {/* Summary badges */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
            <SummaryBadge icon="📦" label="Models" value={result.summary.total_models} />
            <SummaryBadge icon="💾" label="Total Disk" value={result.summary.total_disk_human} />
            {result.summary.error_count > 0 && (
              <SummaryBadge icon="❌" label="Errors" value={result.summary.error_count} color="var(--error)" />
            )}
            {result.summary.warning_count > 0 && (
              <SummaryBadge icon="⚠️" label="Warnings" value={result.summary.warning_count} color="var(--warning)" />
            )}
            {result.summary.notice_count > 0 && (
              <SummaryBadge icon="ℹ️" label="Notices" value={result.summary.notice_count} color="var(--text-dim)" />
            )}
            {result.summary.conversion_candidate_count > 0 && (
              <SummaryBadge icon="🔄" label="Convert Candidates" value={result.summary.conversion_candidate_count} color="var(--accent)" />
            )}
          </div>

          {/* Disk Usage */}
          {result.disk_usage.by_category.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                <span>💾</span> Disk Usage by Category
              </h3>
              <DiskUsageBars categories={result.disk_usage.by_category} />
            </div>
          )}

          {/* Filter toolbar */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {filteredModels.length} of {result.models.length} models
            </span>
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              style={{
                padding: "6px 10px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text)",
                fontSize: 12,
                cursor: "pointer",
                outline: "none",
              }}
            >
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              style={{
                padding: "6px 10px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text)",
                fontSize: 12,
                cursor: "pointer",
                outline: "none",
              }}
            >
              <option value="">All Status</option>
              <option value="ok">✅ OK</option>
              <option value="warning">⚠️ Warning</option>
              <option value="error">❌ Error</option>
            </select>
          </div>

          {/* Model table */}
          <div style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}>
            {/* Table header */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "36px 1fr 140px 90px 110px",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              background: "var(--bg-elevated)",
              borderBottom: "1px solid var(--border)",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-dim)",
              textTransform: "uppercase" as const,
            }}>
              <span></span>
              <span>Model</span>
              <span>Format</span>
              <span>Size</span>
              <span>Category</span>
            </div>

            {/* Table body */}
            <div style={{ maxHeight: 600, overflowY: "auto" }}>
              {filteredModels.length === 0 ? (
                <div style={{ padding: 30, textAlign: "center", color: "var(--text-dim)", fontSize: 14 }}>
                  No models match the current filter.
                </div>
              ) : (
                filteredModels.map((m) => (
                  <ModelRow
                    key={m.label}
                    model={m}
                    expanded={expandedLabel === m.label}
                    onToggle={() => setExpandedLabel(expandedLabel === m.label ? null : m.label)}
                  />
                ))
              )}
            </div>
          </div>

          <ConversionSection candidates={result.conversion_candidates} />
          <OrphanSection orphans={result.orphans} />
        </>
      )}

      {!result && !running && !error && (
        <div style={{ color: "var(--text-dim)", fontSize: 14, marginTop: 40, textAlign: "center" }}>
          Click "Run Model Check" to scan and validate all models.
        </div>
      )}
    </div>
  );
}

export const modelCheckDescriptor: ViewDescriptor = {
  id: "model-check", group: "Tools", label: "Model Check", icon: "📦",
  component: ModelCheckView,
};
