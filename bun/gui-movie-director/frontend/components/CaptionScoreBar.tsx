import React, { useState } from "react";

const SCORE_KEYS = [
  { key: "overall", label: "Overall" },
  { key: "detail", label: "Detail" },
  { key: "sharpness", label: "Sharpness" },
  { key: "composition", label: "Composition" },
  { key: "prompt_adherence", label: "Adherence" },
  { key: "artifacts", label: "Artifacts" },
];

interface CaptionScoreBarProps {
  scores: Record<string, number>;
  issues?: string[];
  strengths?: string[];
  captured?: string[];
  missed?: string[];
  summary?: string;
}

function scoreColor(val: number): string {
  if (val >= 8) return "var(--success)";
  if (val >= 5) return "var(--warning)";
  return "var(--error)";
}

export function CaptionScoreBar({ scores, issues, strengths, captured, missed, summary }: CaptionScoreBarProps) {
  const [expanded, setExpanded] = useState(false);
  const avg = SCORE_KEYS.reduce((sum, k) => sum + (scores[k.key] || 0), 0) / SCORE_KEYS.length;

  return (
    <div style={{ marginTop: 8 }}>
      {/* Score bars */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {SCORE_KEYS.map(({ key, label }) => {
          const val = scores[key] || 0;
          const pct = val * 10;
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 80, fontSize: 11, color: "var(--text-dim)", textAlign: "right", flexShrink: 0 }}>{label}</span>
              <div style={{ flex: 1, height: 14, background: "var(--bg-elevated)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: scoreColor(val), borderRadius: 3, transition: "width 0.3s" }} />
              </div>
              <span style={{ width: 20, fontSize: 12, fontWeight: 600, textAlign: "right", color: scoreColor(val) }}>{val}</span>
            </div>
          );
        })}
      </div>

      {/* Summary */}
      {summary && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>{summary}</div>
      )}

      {/* Expand/collapse for details */}
      {(issues?.length || strengths?.length || captured?.length || missed?.length) ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", padding: "4px 0", marginTop: 4 }}
        >
          {expanded ? "▾ Hide details" : "▸ Show details"}
        </button>
      ) : null}

      {expanded && (
        <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5 }}>
          {captured && captured.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <b style={{ color: "var(--success)" }}>Captured:</b>{" "}
              {captured.map((c, i) => (
                <span key={i} style={{ display: "inline-block", padding: "1px 6px", margin: 1, background: "rgba(76,175,80,0.15)", borderRadius: 3, color: "var(--success)" }}>{c}</span>
              ))}
            </div>
          )}
          {missed && missed.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <b style={{ color: "var(--error)" }}>Missed:</b>{" "}
              {missed.map((m, i) => (
                <span key={i} style={{ display: "inline-block", padding: "1px 6px", margin: 1, background: "rgba(244,67,54,0.15)", borderRadius: 3, color: "var(--error)" }}>{m}</span>
              ))}
            </div>
          )}
          {strengths && strengths.length > 0 && (
            <div style={{ marginBottom: 4, color: "var(--text-dim)" }}>
              <b>Strengths:</b> {strengths.join("; ")}
            </div>
          )}
          {issues && issues.length > 0 && (
            <div style={{ color: "var(--text-dim)" }}>
              <b>Issues:</b> {issues.join("; ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Parse the caption string (which may be JSON wrapped in markdown fences)
 * into a structured scores object. Returns null if parsing fails.
 */
export function parseCaptionScores(caption: any): Record<string, number> | null {
  if (!caption) return null;
  if (typeof caption === "object") return caption;
  if (typeof caption !== "string") return null;

  let s = caption.trim();
  // Strip markdown fences
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  try {
    return JSON.parse(s);
  } catch {
    const match = s.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}
