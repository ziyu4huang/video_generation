/**
 * Longitudinal aggregation — per-session results → rate series + verdicts. PURE.
 *
 * Rate, not count. Session lengths vary by an order of magnitude, so a count-based
 * series is dominated by a handful of long sessions and a busy week reads as a
 * regression when nothing degraded.
 *
 * The caller is responsible for passing ONLY sessions that contain at least one
 * tool call. Measured: 2,226 of 3,391 family sessions have no tool call at all and
 * cannot trigger any detector, so including them dilutes every rate ~3x and makes
 * the series track prompt volume instead of agent behaviour.
 *
 * No significance testing. CONTEXT.md defines a pathology detector as deterministic
 * and signal-driven (_Avoid: heuristic_); a p-value over a sample that is neither
 * independent nor identically distributed would manufacture false rigour. The
 * honesty mechanism is minEvents, which withholds a verdict instead of guessing.
 */

/** One replayed session, reduced to the checks it fired. */
export interface SessionResult {
  startedAt: number;
  /** Distinct check ids that fired, excluding the info-level session-stats. */
  checks: string[];
}

export interface AggregateOptions {
  /** Sessions per window. Measured default: 200 (~8 days at the observed rate). */
  windowSize: number;
  /** Minimum baseline-window occurrences required to issue a verdict. */
  minEvents: number;
  /** Percentage-point move that counts as a regression / improvement. */
  deltaPct: number;
}

export interface SeriesPoint {
  /** 0-based window index, oldest first. */
  window: number;
  sessions: number;
  occurrences: number;
  ratePct: number;
}

export interface CheckSeries {
  check: string;
  points: SeriesPoint[];
}

export type Verdict = "regressed" | "improved" | "stable" | "insufficient-signal";

export interface RegressionVerdict {
  check: string;
  baselineRatePct: number;
  recentRatePct: number;
  /** recent − baseline, in percentage points. */
  deltaPct: number;
  baselineEvents: number;
  verdict: Verdict;
}

export interface AggregateReport {
  totalSessions: number;
  windows: number;
  series: CheckSeries[];
  verdicts: RegressionVerdict[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Bucket sessions into fixed-size windows (oldest first) and rate each check. */
export function aggregate(rows: SessionResult[], opts: AggregateOptions): AggregateReport {
  const sorted = [...rows].sort((a, b) => a.startedAt - b.startedAt);

  const windows: SessionResult[][] = [];
  for (let i = 0; i < sorted.length; i += opts.windowSize) {
    windows.push(sorted.slice(i, i + opts.windowSize));
  }

  const checks = [...new Set(sorted.flatMap((r) => r.checks))].sort();

  const series: CheckSeries[] = checks.map((check) => ({
    check,
    points: windows.map((w, i) => {
      const occurrences = w.filter((r) => r.checks.includes(check)).length;
      return {
        window: i,
        sessions: w.length,
        occurrences,
        ratePct: w.length ? round1((occurrences / w.length) * 100) : 0,
      };
    }),
  }));

  // A verdict needs a full baseline window and a recent window to compare.
  const verdicts: RegressionVerdict[] = [];
  if (windows.length >= 2) {
    for (const s of series) {
      const baseline = s.points[s.points.length - 2]!;
      const recent = s.points[s.points.length - 1]!;
      const deltaPct = round1(recent.ratePct - baseline.ratePct);
      const verdict: Verdict =
        baseline.occurrences < opts.minEvents
          ? "insufficient-signal"
          : deltaPct >= opts.deltaPct
            ? "regressed"
            : deltaPct <= -opts.deltaPct
              ? "improved"
              : "stable";
      verdicts.push({
        check: s.check,
        baselineRatePct: baseline.ratePct,
        recentRatePct: recent.ratePct,
        deltaPct,
        baselineEvents: baseline.occurrences,
        verdict,
      });
    }
  }

  return { totalSessions: sorted.length, windows: windows.length, series, verdicts };
}
