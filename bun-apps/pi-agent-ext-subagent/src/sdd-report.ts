/**
 * SDD (subagent-driven-development) report parsing.
 *
 * claude-code's implementer-prompt.md instructs the subagent to return a ≤15-line
 * prose block whose first structured line is `**Status:** DONE|DONE_WITH_CONCERNS|
 * NEEDS_CONTEXT|BLOCKED`, followed by commits / a one-line test summary /
 * concerns / the report-file path. claude-code's CONTROLLER parses that prose.
 *
 * This module makes the same block MACHINE-READABLE on the `subagent` tool
 * (ticket 04): `parseSddReport(output)` returns a typed `SddReport` when the
 * output carries the `**Status:**` marker, else `undefined` (a plain non-SDD
 * dispatch has no report). `status` is parsed reliably (a fixed enum with one
 * canonical marker); the remaining fields are best-effort — extracted when the
 * prose is shaped as the SDD prompt produces, `undefined` otherwise. The
 * controller branches on `report.status`; the rest are hints.
 *
 * The SDD prompt template is byte-identical to upstream (do not edit); this
 * parser reads its OUTPUT, never the template, so it composes with the
 * unmodified superpowers skill.
 */

/** The four SDD self-report statuses (verbatim from implementer-prompt.md). */
export type SddReportStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

/**
 * The parsed SDD report block. `status` is always present when the report is
 * recognized; every other field is best-effort.
 */
export interface SddReport {
  status: SddReportStatus;
  /** Short commit SHAs the implementer created (best-effort; may over-match hex). */
  commits?: string[];
  /** One-line test summary, e.g. "14/14 passing" (best-effort). */
  testSummary?: string;
  /** The implementer's stated concerns (best-effort). */
  concerns?: string;
  /** Path to the full report file (best-effort). */
  reportFile?: string;
}

export const SDD_REPORT_STATUSES: readonly SddReportStatus[] = [
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
];

// Order matters: DONE_WITH_CONCERNS must be tried before DONE (DONE is a prefix).
const STATUS_RE = /\*\*\s*Status\s*:?\s*\*\*\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\b/i;
const REPORT_FILE_RE = /([A-Za-z0-9_./@-]+\.md)\b/;
const SHORT_SHA_RE = /\b([0-9a-f]{7,40})\b/gi;
const TEST_SUMMARY_RE = /([^\n]*\b\d+\s*\/\s*\d+\s*passing[^\n]*)/i;
const CONCERNS_RE = /\bconce(?:rns?|rn)\b[:\s-]*\n?([^\n]+)/i;

/**
 * Parse an SDD report block from a subagent's output. Returns `undefined` when
 * the output carries no `**Status:**` marker (i.e. it is not an SDD report — a
 * plain dispatch, a schema-structured result, or a failure with empty output).
 *
 * `status` is the reliable field; `commits` / `testSummary` / `concerns` /
 * `reportFile` are best-effort and `undefined` when not cleanly present.
 */
export function parseSddReport(output: string | undefined): SddReport | undefined {
  if (!output) return undefined;
  const statusMatch = output.match(STATUS_RE);
  if (!statusMatch) return undefined;

  const statusStr = statusMatch[1];
  if (!statusStr) return undefined;
  const status = statusStr.toUpperCase() as SddReportStatus;

  const reportFile = output.match(REPORT_FILE_RE)?.[1];

  // Collect unique short SHAs, preserving first-seen order. Best-effort: a
  // 7+ hex run can be a non-commit hash, so callers treat these as hints.
  let commits: string[] | undefined;
  const shaIter = output.matchAll(SHORT_SHA_RE);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of shaIter) {
    const sha = m[1];
    if (sha && !seen.has(sha)) {
      seen.add(sha);
      ordered.push(sha);
    }
  }
  if (ordered.length) commits = ordered;

  const testSummary = (output.match(TEST_SUMMARY_RE)?.[1] ?? undefined)?.trim();
  const concerns = (output.match(CONCERNS_RE)?.[1] ?? undefined)?.trim();

  const report: SddReport = { status };
  if (commits) report.commits = commits;
  if (testSummary) report.testSummary = testSummary;
  if (concerns) report.concerns = concerns;
  if (reportFile) report.reportFile = reportFile;
  return report;
}

/**
 * Classify an SDD status for display: the statuses that warrant a warning tint
 * (the controller must act on them) vs. the clean ones.
 */
export function isSddReportActionable(status: SddReportStatus): boolean {
  return status === "BLOCKED" || status === "NEEDS_CONTEXT" || status === "DONE_WITH_CONCERNS";
}
