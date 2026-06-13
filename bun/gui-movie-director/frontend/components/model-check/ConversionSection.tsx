import React from "react";
import { formatBytes } from "../../utils/format";
import type { ConversionCandidate } from "./types";

export function ConversionSection({ candidates }: { candidates: ConversionCandidate[] }) {
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
