/**
 * format.ts — token-estimate and bar-rendering helpers shared by the inspect_*
 * report formatters. Extracted from index.ts alongside findings.ts.
 */
import { DEFAULT_CHARS_PER_TOKEN } from "./schema-cost";


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
