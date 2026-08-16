/**
 * power-tool history — longitudinal analysis over pi-agent session transcripts.
 *
 * Layering (strictly one-way): scan → replay → aggregate. `scope` and `sidecar`
 * are leaves. Nothing here imports a tool module or the extension entry.
 */
export { type CallRec, type ResultRec, type SessionScan, parseSessionLines } from "./scan.ts";
export {
  type ReplayOptions,
  replayScan,
  resolveContextPercent,
  toPathologyInput,
} from "./replay.ts";
export { type ScopeSpec, buildScope, inScope } from "./scope.ts";
export {
  type AggregateOptions,
  type AggregateReport,
  type CheckSeries,
  type RegressionVerdict,
  type SeriesPoint,
  type SessionResult,
  type Verdict,
  aggregate,
} from "./aggregate.ts";
