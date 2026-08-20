/**
 * Pathology report formatter — PURE.
 *
 * Renders Finding[] (from analyzePathology) as a severity-ranked text report, built
 * from the shared chrome in ../report.ts so every inspect_* report looks the same.
 * The one deviation is the count line, which says "pathology(ies)" rather than
 * "issue(s)" — this report speaks about session behaviour, not static defects.
 */
import type { Finding } from "../findings.ts";
import { summarizeFindings } from "../findings.ts";
import { reportHeader, severitySections } from "../report.js";
import type { ToolCallRecord } from "./types.ts";

/** Render pathology findings as a human-readable severity-ranked report. PURE. */
export function formatPathologyReport(findings: Finding[], recent: ToolCallRecord[] = []): string {
  const lines = reportHeader("Inspect Pathology");

  const summary = summarizeFindings(findings);
  lines.push(
    `▶ ${summary.total} pathology(ies): 🔴 ${summary.high} high · 🟡 ${summary.medium} medium · 🟢 ${summary.low} low`,
    "",
  );
  lines.push(...severitySections(findings, "No pathologies detected — session looks healthy."));

  // Recent-calls tail — grounds the diagnosis in what actually happened.
  if (recent.length > 0) {
    lines.push(`▶ Recent tool calls (last ${Math.min(recent.length, 10)}):`);
    for (const c of recent.slice(-10)) {
      const status = c.isError ? "ERR" : "ok";
      const preview = c.argsSig.slice(0, 60);
      lines.push(`  ${c.toolName.padEnd(20)} ${status.padEnd(4)} ${preview}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
