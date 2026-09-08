/**
 * Pure aggregation for the qualify sweep driver (self-arc-14 t01).
 *
 * qualify.ts SPAWS tui-drive.ts per scenario (D2: independent processes against
 * the deployed launcher) and this module turns the collected receipts into the
 * summary table + exit-code verdict. No spawns, no LLM — unit-gated.
 */

export const ALL_SCENARIOS = [
  "dispatch",
  "parallel",
  "viewer",
  "agents",
  "reload",
  "swarm",
  "catalog",
  "workflow",
  "wf-pause",
  "cc-parity",
] as const;

export type ScenarioId = (typeof ALL_SCENARIOS)[number];

/** One scenario's outcome as collected by the driver (NOT the raw receipt). */
export interface ScenarioOutcome {
  scenario: string;
  /** tui-drive's own receipt verdict; null = receipt missing/unreadable. */
  receiptPass: boolean | null;
  /** Child process exit code (0 = green). */
  exitCode: number | null;
  wallMs: number;
  receiptPath: string;
  rpcCrossCheck?: string;
}

/** Red = receipt says fail, OR receipt missing/unreadable (never silently
 *  skipped — a vanished receipt is evidence of a crash, not a pass). */
export function isRed(o: ScenarioOutcome): boolean {
  if (o.exitCode !== null && o.exitCode !== 0) return true;
  return o.receiptPass !== true;
}

export interface Summary {
  rows: ScenarioOutcome[];
  allGreen: boolean;
  redCount: number;
  md: string;
  json: string;
}

export function buildSummary(rows: ScenarioOutcome[]): Summary {
  const allGreen = rows.every((r) => !isRed(r));
  const redCount = rows.filter(isRed).length;
  const lines: string[] = [];
  lines.push("# qualify — tui-drive deployed sweep", "");
  lines.push(`Scenarios: ${rows.length} · green: ${rows.length - redCount} · red: ${redCount}`, "");
  lines.push("| scenario | verdict | wall | rpc |");
  lines.push("|---|---|---|---|");
  for (const r of rows) {
    const verdict = isRed(r) ? "❌ RED" : "✅";
    const wall = r.wallMs > 0 ? `${(r.wallMs / 1000).toFixed(1)}s` : "—";
    lines.push(`| ${r.scenario} | ${verdict} | ${wall} | ${r.rpcCrossCheck ?? "—"} |`);
  }
  lines.push("");
  const jsonPayload = {
    allGreen,
    redCount,
    rows: rows.map((r) => ({
      scenario: r.scenario,
      pass: !isRed(r),
      receiptPass: r.receiptPass,
      exitCode: r.exitCode,
      wallMs: r.wallMs,
      receiptPath: r.receiptPath,
      rpcCrossCheck: r.rpcCrossCheck ?? null,
    })),
  };
  return {
    rows,
    allGreen,
    redCount,
    md: lines.join("\n"),
    json: `${JSON.stringify(jsonPayload, null, 2)}\n`,
  };
}
