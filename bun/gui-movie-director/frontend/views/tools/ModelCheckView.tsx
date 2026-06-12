import React, { useState, useEffect } from "react";
import type { ViewDescriptor } from "../registry";
import { relativeTime, formatBytes } from "../../utils/format";

// ── Types ──────────────────────────────────────────────────────────────

interface ModelCheckSummary {
  total_models: number;
  total_disk_bytes: number;
  total_disk_human: string;
  error_count: number;
  warning_count: number;
  notice_count: number;
  conversion_candidate_count: number;
  orphan_count: number;
}

interface DiskCategory {
  category: string;
  bytes: number;
  count: number;
  human: string;
}

interface TopModel {
  label: string;
  bytes: number;
  human: string;
}

interface ModelValidation {
  errors: string[];
  warnings: string[];
  notices: string[];
}

interface ModelEntry {
  label: string;
  category: string;
  manifest: Record<string, any>;
  disk_bytes: number;
  disk_human: string;
  weight_file: string | null;
  has_readme: boolean;
  has_config: boolean;
  downloading: boolean;
  disabled: boolean;
  validation: ModelValidation;
  status: "ok" | "warning" | "error";
}

interface ConversionCandidate {
  label: string;
  format: string;
  size_bytes: number;
  size_human: string;
  target_format: string;
  est_size: number;
  est_size_human: string;
  savings_bytes: number;
  savings_human: string;
  convert_flag: string;
}

interface OrphanEntry {
  category: string;
  instance: string;
}

interface ModelCheckResult {
  timestamp: string;
  models_dir: string;
  summary: ModelCheckSummary;
  disk_usage: {
    by_category: DiskCategory[];
    top_models: TopModel[];
  };
  models: ModelEntry[];
  conversion_candidates: ConversionCandidate[];
  orphans: OrphanEntry[];
}

// ── Sub-components ─────────────────────────────────────────────────────

function SummaryBadge({ icon, label, value, color }: {
  icon: string; label: string; value: string | number; color?: string;
}) {
  return (
    <div className="mc-badge" style={color ? { borderColor: color } : undefined}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: color || "var(--text-bright)", lineHeight: 1.2 }}>
          {value}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</div>
      </div>
    </div>
  );
}

function DiskUsageBars({ categories }: { categories: DiskCategory[] }) {
  const maxBytes = Math.max(...categories.map((c) => c.bytes), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {categories.map((c) => {
        const pct = Math.max((c.bytes / maxBytes) * 100, 1);
        const hue = 210 - (pct / 100) * 30;
        return (
          <div key={c.category} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 120, textAlign: "right", fontSize: 12, color: "var(--text-dim)", flexShrink: 0 }}>
              {c.category}
            </div>
            <div style={{ flex: 1, height: 22, background: "var(--bg-elevated)", borderRadius: 4, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  borderRadius: 4,
                  background: `hsl(${hue}, 60%, 50%)`,
                  display: "flex",
                  alignItems: "center",
                  paddingLeft: 8,
                  fontSize: 11,
                  color: "#fff",
                  fontWeight: 500,
                  transition: "width 0.3s",
                }}
              >
                {pct > 15 ? c.human : ""}
              </div>
            </div>
            <div style={{ width: 80, fontSize: 12, color: "var(--text)", flexShrink: 0 }}>{c.human}</div>
            <div style={{ width: 80, fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
              {c.count} {c.count === 1 ? "model" : "models"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ModelRow({ model, expanded, onToggle }: {
  model: ModelEntry; expanded: boolean; onToggle: () => void;
}) {
  const mf = model.manifest;
  const statusIcon = model.status === "error" ? "❌" : model.status === "warning" ? "⚠️" : "✅";
  const statusColor = model.status === "error" ? "var(--error)" : model.status === "warning" ? "var(--warning)" : "var(--success)";

  const flags: string[] = [];
  if (model.downloading) flags.push("⏳ downloading");
  if (model.disabled) flags.push("🚫 disabled");

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: "36px 1fr 140px 90px 110px",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          cursor: "pointer",
          userSelect: "none",
          borderRadius: "var(--radius)",
          background: expanded ? "var(--bg-elevated)" : "transparent",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <span style={{ color: statusColor, textAlign: "center" }}>{statusIcon}</span>
        <span style={{ fontWeight: 500, color: "var(--text)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {model.label}
          {flags.length > 0 && (
            <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-dim)" }}>{flags.join(" ")}</span>
          )}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{mf.format || "—"}</span>
        <span style={{ fontSize: 12, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
          {model.disk_human || "—"}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{model.category}</span>
      </div>

      {expanded && (
        <div style={{ padding: "8px 10px 12px 46px", background: "var(--bg-surface)", borderRadius: "var(--radius)", marginTop: 2 }}>
          {/* Manifest detail grid */}
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 140px 1fr", gap: "4px 16px", fontSize: 12 }}>
            {[
              ["Arch", mf.arch],
              ["Source", mf.source],
              ["Source URL", mf.source_url],
              ["HF Repo", mf.hf_repo],
              ["Description", mf.description],
              ["Declared Size", model.disk_bytes ? model.disk_human : ""],
              ["Weight File", model.weight_file],
              ["Pipeline", (mf.pipeline || []).join(", ")],
              ["Compatible With", (mf.compatible_with || []).join(", ")],
              ["Trigger Words", (mf.trigger_words || []).join(", ")],
              ["Convert Flag", mf.convert_flag],
              ["Created", mf.created_at],
            ].map(([k, v]) =>
              v ? (
                <React.Fragment key={k}>
                  <div style={{ color: "var(--text-dim)", fontWeight: 500 }}>{k}</div>
                  <div style={{ color: "var(--text)", wordBreak: "break-all" }}>{String(v)}</div>
                </React.Fragment>
              ) : null
            )}
          </div>

          {/* Files */}
          <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-dim)" }}>
            Files: {[
              model.has_readme ? "README.md" : null,
              model.has_config ? "config.json" : null,
              model.weight_file,
            ].filter(Boolean).join(", ") || "none"}
          </div>

          {/* Validation messages */}
          {(() => {
            const v = model.validation;
            const hasVal = v.errors.length || v.warnings.length || v.notices.length;
            if (!hasVal) return null;
            return (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                  Validation
                </div>
                {v.errors.map((e, i) => (
                  <div key={`e${i}`} style={{ fontSize: 12, color: "var(--error)", padding: "1px 0" }}>❌ {e}</div>
                ))}
                {v.warnings.map((w, i) => (
                  <div key={`w${i}`} style={{ fontSize: 12, color: "var(--warning)", padding: "1px 0" }}>⚠️ {w}</div>
                ))}
                {v.notices.map((n, i) => (
                  <div key={`n${i}`} style={{ fontSize: 12, color: "var(--text-dim)", padding: "1px 0" }}>ℹ️ {n}</div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function ConversionSection({ candidates }: { candidates: ConversionCandidate[] }) {
  if (!candidates.length) return null;
  const totalSavings = candidates.reduce((acc, c) => acc + c.savings_bytes, 0);
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span>🔄</span> MLX Conversion Candidates ({candidates.length})
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {candidates.map((c) => (
          <div key={c.label} style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            padding: "8px 12px", background: "var(--bg-surface)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", fontSize: 12,
          }}>
            <span style={{ fontWeight: 500, color: "var(--accent)", minWidth: 200 }}>{c.label}</span>
            <span>{c.size_human} ({c.format})</span>
            <span style={{ color: "var(--text-dim)" }}>→</span>
            <span>~{c.est_size_human} {c.target_format}</span>
            <span style={{ color: "var(--success)", fontWeight: 500 }}>(save ~{c.savings_human})</span>
            {c.convert_flag && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--bg-elevated)", padding: "2px 6px", borderRadius: 3 }}>
                {c.convert_flag}
              </span>
            )}
          </div>
        ))}
        <div style={{
          padding: "8px 12px", background: "var(--bg-surface)", border: `1px solid var(--success)`,
          borderRadius: "var(--radius)", fontSize: 12, color: "var(--success)", fontWeight: 600,
        }}>
          Total potential savings: ~{formatBytes(totalSavings)}
        </div>
      </div>
    </div>
  );
}

function OrphanSection({ orphans }: { orphans: OrphanEntry[] }) {
  if (!orphans.length) return null;
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span>⚠️</span> Orphan Directories ({orphans.length})
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {orphans.map((o) => (
          <div key={`${o.category}/${o.instance}`} style={{
            padding: "6px 12px", background: "var(--bg-surface)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", fontSize: 12, color: "var(--warning)",
          }}>
            {o.category}/{o.instance} — no manifest.json
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main View ──────────────────────────────────────────────────────────

export function ModelCheckView() {
  const [result, setResult] = useState<ModelCheckResult | null>(null);
  const [running, setRunning] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);

  // Load cached result on mount
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

  // Filtered models
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

          {/* Conversion candidates */}
          <ConversionSection candidates={result.conversion_candidates} />

          {/* Orphan directories */}
          <OrphanSection orphans={result.orphans} />
        </>
      )}

      {/* Empty state (no result and not running) */}
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
