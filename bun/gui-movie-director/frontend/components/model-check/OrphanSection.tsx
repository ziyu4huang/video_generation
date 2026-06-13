import React from "react";
import type { OrphanEntry } from "./types";

export function OrphanSection({ orphans }: { orphans: OrphanEntry[] }) {
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
