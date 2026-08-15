/**
 * findings.ts — the shared finding vocabulary for every inspect_* tool.
 *
 * Extracted from index.ts so tool modules can import it without importing the
 * extension factory. Before this file existed, `tools/inspect-hooks.ts` carried
 * a verbatim copy of Severity / Finding / summarizeFindings / shortPath purely
 * to dodge a module-init cycle with ../index.js — a cycle that only existed
 * because this vocabulary lived in the same file as the tool registry.
 */

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  /** machine id, e.g. "duplicate-tool-name" */
  check: string;
  /** one human-readable line */
  message: string;
  /** structured payload (for JSON mode / assertions) */
  detail?: Record<string, unknown>;
}


/** Compact a source path for table display: prefer the bun-apps/... tail. */
export function shortPath(p: string): string {
  const i = p.indexOf("bun-apps/");
  if (i >= 0) return p.slice(i);
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}

/** Count actionable issues (excluding info) by severity. PURE. */
export function summarizeFindings(findings: Finding[]): {
  total: number;
  high: number;
  medium: number;
  low: number;
} {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === "info") continue;
    counts[f.severity as "high" | "medium" | "low"] += 1;
  }
  return { total: counts.high + counts.medium + counts.low, ...counts };
}
