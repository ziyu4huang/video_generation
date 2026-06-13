import React from "react";

export function SummaryBadge({ icon, label, value, color }: {
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
