import React from "react";

export function ParamBadge({ params, filename }: { params: Record<string, any>; filename: string }) {
  const parts: string[] = [];
  if (params.denoise_strength != null) parts.push(`dn=${params.denoise_strength}`);
  if (params.controlnet_strength != null) parts.push(`cnet=${params.controlnet_strength}`);
  if (params.steps != null) parts.push(`${params.steps}st`);
  if (params.seed != null) parts.push(`s${params.seed}`);
  if (params.cnet_active_steps != null) parts.push(`act=${params.cnet_active_steps}`);
  const text = parts.length > 0 ? parts.join(" ") : filename.replace(/\.[^.]+$/, "");
  return (
    <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", wordBreak: "break-all", lineHeight: 1.4 }}>
      {text}
    </div>
  );
}
