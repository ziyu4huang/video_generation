import React from "react";
import type { ModelEntry } from "./types";

export function ModelRow({ model, expanded, onToggle }: {
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

          <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-dim)" }}>
            Files: {[
              model.has_readme ? "README.md" : null,
              model.has_config ? "config.json" : null,
              model.weight_file,
            ].filter(Boolean).join(", ") || "none"}
          </div>

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
