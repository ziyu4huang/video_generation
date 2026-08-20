/**
 * Historical replay — SessionScan → PathologyInput → analyzePathology(). PURE.
 *
 * The detectors are NOT modified and NOT reimplemented: analyzePathology() is
 * already a pure function over PathologyInput, so replaying history is a matter of
 * building that input from a transcript instead of from the live accumulator.
 *
 * argsSig is imported from the detector — the SAME function the accumulator uses
 * (see accumulator.ts). Reimplementing it would let live detection and historical
 * replay disagree about what "the same call" means, and that divergence would be
 * silent. `replay.test.ts` pins the two paths together.
 *
 * Two documented approximations, both inherited from what transcripts record:
 *  - turnCount uses the assistant-message count; transcripts carry no turn_end event.
 *  - contextPercent uses the session's PEAK usage.totalTokens over the model's
 *    context window, and is null when the window cannot be resolved.
 */
import { analyzePathology, argsSig } from "../pathology/detector.ts";
import type { PathologyInput, ToolCallRecord } from "../pathology/types.ts";
import type { Finding } from "../findings.ts";
import type { SessionScan } from "./scan.ts";

/** Threshold overrides forwarded verbatim to analyzePathology(). */
export type ReplayOptions = Omit<PathologyInput, "calls" | "contextPercent" | "turnCount"> & {
  /** modelId → context window in tokens. Omit to leave contextPercent null. */
  windows?: Map<string, number>;
};

/**
 * Peak context fill as a percentage, or null when unmeasurable.
 *
 * Returns null — never 0 — when the model's window is unknown or no usage was
 * recorded. A silently-zero series is indistinguishable from a healthy one, which
 * is the worse failure for a trend report.
 */
export function resolveContextPercent(
  scan: Pick<SessionScan, "modelId" | "maxTotalTokens">,
  windows: Map<string, number> | undefined,
): number | null {
  if (!windows || !scan.modelId || !scan.maxTotalTokens) return null;
  const w = windows.get(scan.modelId);
  if (!w) return null;
  return (scan.maxTotalTokens / w) * 100;
}

/** Build the detector input from a scanned transcript. */
export function toPathologyInput(scan: SessionScan, opts: ReplayOptions = {}): PathologyInput {
  const { windows, ...thresholds } = opts;

  // Pair results back onto their calls by callId, mirroring what the live
  // accumulator does with tool_execution_start / tool_execution_end.
  const errorByCallId = new Map<string, boolean>();
  for (const r of scan.results) errorByCallId.set(r.callId, r.isError);

  const calls: ToolCallRecord[] = scan.calls.map((c) => ({
    toolName: c.name,
    argsSig: argsSig(c.args),
    isError: errorByCallId.get(c.callId) ?? false,
    ts: c.t0,
  }));

  // A result with no matching call still carries a real success/failure fact —
  // the accumulator records these too (accumulator.ts recordCallEnd fallback).
  const callIds = new Set(scan.calls.map((c) => c.callId));
  for (const r of scan.results) {
    if (!callIds.has(r.callId)) {
      calls.push({ toolName: r.name, argsSig: "(end-only)", isError: r.isError, ts: r.t1 });
    }
  }
  calls.sort((a, b) => a.ts - b.ts);

  return {
    ...thresholds,
    calls,
    contextPercent: resolveContextPercent(scan, windows),
    turnCount: scan.assistantMessages,
  };
}

/** Replay every detector over one historical session. */
export function replayScan(scan: SessionScan, opts: ReplayOptions = {}): Finding[] {
  return analyzePathology(toPathologyInput(scan, opts));
}
