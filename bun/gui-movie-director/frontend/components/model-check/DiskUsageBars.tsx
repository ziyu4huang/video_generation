import React from "react";
import type { DiskCategory } from "./types";

export function DiskUsageBars({ categories }: { categories: DiskCategory[] }) {
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
