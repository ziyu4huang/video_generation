/**
 * Pathology report formatter — PURE.
 *
 * Renders Finding[] (from analyzePathology) as a severity-ranked text report in
 * the same style as inspect_extensions. Reuses summarizeFindings + the Severity
 * section pattern from the package entry so all inspect_* reports feel uniform.
 *
 * Only `Finding`/`Severity` types and the `summarizeFindings` function are
 * imported from src/index.ts. summarizeFindings is a hoisted function
 * declaration, so even though src/index.ts imports this module's sibling tool
 * wrapper, there is no runtime initialization-order hazard.
 */
import type { Finding, Severity } from "../findings.ts";
import { summarizeFindings } from "../findings.ts";
import type { ToolCallRecord } from "./types.ts";

/** Render pathology findings as a human-readable severity-ranked report. PURE. */
export function formatPathologyReport(findings: Finding[], recent: ToolCallRecord[] = []): string {
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════╗");
  lines.push("║         Inspect Pathology            ║");
  lines.push("╚══════════════════════════════════════╝");
  lines.push("");

  const summary = summarizeFindings(findings);
  lines.push(
    `▶ ${summary.total} pathology(ies): 🔴 ${summary.high} high · 🟡 ${summary.medium} medium · 🟢 ${summary.low} low`,
  );
  lines.push("");

  const section = (sev: Severity, icon: string, label: string) => {
    const items = findings.filter((f) => f.severity === sev);
    if (items.length === 0) return;
    lines.push(`▶ ${icon} ${label} (${items.length}):`);
    for (const f of items) lines.push(`  • ${f.message}`);
    lines.push("");
  };

  if (summary.total === 0) {
    lines.push("✓ No pathologies detected — session looks healthy.");
    lines.push("");
  } else {
    section("high", "🔴", "High");
    section("medium", "🟡", "Medium");
    section("low", "🟢", "Low");
  }

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
