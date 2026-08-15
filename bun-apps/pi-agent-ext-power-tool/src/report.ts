/**
 * report.ts — the shared render vocabulary for every inspect_* text report:
 * token/bar formatting plus the header box, the summary line, and the severity
 * sections.
 *
 * Was `format.ts` (token helpers only). The chrome moved in because each tool
 * hand-built its own: the box was retyped five times at two different widths with
 * unaligned padding, and two modules each re-implemented the summary line and the
 * severity sections. Chrome is the part of a diagnostics tool a reader pattern-matches
 * on, so it has to look the same everywhere — which it only does if it is built once.
 */
import { DEFAULT_CHARS_PER_TOKEN } from "./schema-cost/index.ts";
import type { Finding, Severity } from "./findings.js";
import { summarizeFindings } from "./findings.js";

// ─── Token estimation ────────────────────────────────────────────────────────

// Rough chars→token estimate. Sourced from schema-cost's canonical default so
// the live instrument (inspect_context) and the static instrument (schema-cost /
// inspect_extensions) can NEVER drift apart. Previously this was a hardcoded 3.7
// while schema-cost used 4.0 — a diagnostics tool must agree with itself.
export const TOKEN_RATIO = DEFAULT_CHARS_PER_TOKEN;

export function est(chars: number): string {
  return `~${Math.round(chars / TOKEN_RATIO).toLocaleString()} tok`;
}

export function estTok(chars: number): number {
  return Math.round(chars / TOKEN_RATIO);
}

export function bar(percent: number | null, width = 28): string {
  if (percent == null) return "[" + " ".repeat(width) + "] ??%";
  const filled = Math.round((percent / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + `] ${percent.toFixed(1)}%`;
}

export function miniBar(fraction: number, width = 12): string {
  const filled = Math.round(Math.min(1, fraction) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Report chrome ───────────────────────────────────────────────────────────

/** Inner width of the report header box, in columns. */
const HEADER_WIDTH = 38;

/**
 * The banner every inspect_* report opens with, centred in a fixed-width box, plus
 * the blank line that follows it. Returns lines (not a string) so callers keep
 * pushing into their own `lines[]`.
 */
export function reportHeader(title: string): string[] {
  const rule = "═".repeat(HEADER_WIDTH);
  const pad = Math.max(0, HEADER_WIDTH - title.length);
  const left = Math.floor(pad / 2);
  const inner = " ".repeat(left) + title + " ".repeat(pad - left);
  return [`╔${rule}╗`, `║${inner}║`, `╚${rule}╝`, ""];
}

/** `▶ N issue(s): 🔴 a high · 🟡 b medium · 🟢 c low` — info findings excluded. */
export function findingsSummaryLine(findings: Finding[]): string {
  const s = summarizeFindings(findings);
  return `▶ ${s.total} issue(s): 🔴 ${s.high} high · 🟡 ${s.medium} medium · 🟢 ${s.low} low`;
}

/** `▶ 🟡 Heading (n):` followed by one `  • message` per finding. Empty in ⇒ empty out. */
export function bulletSection(icon: string, heading: string, items: Finding[]): string[] {
  if (items.length === 0) return [];
  const lines = [`▶ ${icon} ${heading} (${items.length}):`];
  for (const f of items) lines.push(`  • ${f.message}`);
  lines.push("");
  return lines;
}

const SEVERITY_CHROME: readonly (readonly [Severity, string, string])[] = [
  ["high", "🔴", "High"],
  ["medium", "🟡", "Medium"],
  ["low", "🟢", "Low"],
];

/**
 * The High/Medium/Low bullet sections, or `allClearMessage` when nothing actionable
 * was found. `info` findings are never rendered here — they belong in the tables a
 * report builds for itself.
 */
export function severitySections(findings: Finding[], allClearMessage: string): string[] {
  if (summarizeFindings(findings).total === 0) return [`✓ ${allClearMessage}`, ""];
  const lines: string[] = [];
  for (const [sev, icon, label] of SEVERITY_CHROME) {
    lines.push(...bulletSection(icon, label, findings.filter((f) => f.severity === sev)));
  }
  return lines;
}
