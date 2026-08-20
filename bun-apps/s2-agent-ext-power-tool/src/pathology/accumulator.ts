/**
 * Hook-fed call accumulator (per-sessionId bounded buffer).
 *
 * The factory registers recordCallStart/recordCallEnd on the SDK's
 * tool_execution_start / tool_execution_end events. Each (toolName, args,
 * isError) observation is appended here; analyzePathology() reads the buffer at
 * call time via getCalls(). State is reset on session_start so each session's
 * diagnostics are self-contained.
 *
 * State is partitioned by sessionId (`ctx.sessionManager.getSessionId()`, a
 * UUIDv7 distinct per SessionManager) so an in-process subagent child — which
 * runs in the SAME process and skips session_start — gets its OWN buffer instead
 * of polluting the parent's retry-loop / error-storm detection. A "" fallback
 * bucket serves ctx-less callers (tests, module-level), preserving legacy
 * single-bucket behavior. Optimization #3 / ticket #16, stage 1 of 4.
 *
 * Module-scoped (not a class) to mirror the ext-task accumulator pattern
 * already proven in this repo. Memory is bounded by MAX_CALLS via a soft cap
 * that slices the oldest entries when a bucket grows to 2× the cap (indices in
 * `pending` are re-based accordingly).
 */
import { argsSig } from "./detector.ts";
import type { ToolCallRecord } from "./types.ts";

const MAX_CALLS = 500;

/** Fallback key for ctx-less callers (tests, module-level) — preserves legacy single-bucket behavior. */
const DEFAULT_SID = "";

interface AccumulatorState {
  calls: ToolCallRecord[];
  /** toolCallId → index in `calls` awaiting its tool_execution_end. */
  pending: Map<string, number>;
  /** Completed-turn count (from turn_end events); null before any turn ends. */
  turnCount: number | null;
}

const emptyState = (): AccumulatorState => ({ calls: [], pending: new Map(), turnCount: null });

/** Per-session buckets. Keyed by ctx.sessionManager.getSessionId() so an in-process
 *  subagent child (distinct SessionManager UUIDv7) gets its own buffer instead of
 *  polluting the parent's. Optimization #3 / ticket #16. */
const states = new Map<string, AccumulatorState>();

function bucket(sid?: string): AccumulatorState {
  const key = sid ?? DEFAULT_SID;
  let s = states.get(key);
  if (!s) {
    s = emptyState();
    states.set(key, s);
  }
  return s;
}

/** Subset of ToolExecutionStartEvent the accumulator reads. */
export interface StartEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}
/** Subset of ToolExecutionEndEvent the accumulator reads. */
export interface EndEvent {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

/** tool_execution_start handler — record the call with a stable args signature. */
export function recordCallStart(e: StartEvent, sid?: string): void {
  const s = bucket(sid);
  const rec: ToolCallRecord = {
    toolName: e.toolName,
    argsSig: argsSig(e.args),
    isError: false,
    ts: Date.now(),
  };
  s.pending.set(e.toolCallId, s.calls.length);
  s.calls.push(rec);
  // Soft cap: drop the oldest slice and re-base pending indices.
  if (s.calls.length > MAX_CALLS * 2) {
    const drop = s.calls.length - MAX_CALLS;
    s.calls = s.calls.slice(drop);
    for (const [id, i] of s.pending) {
      const ni = i - drop;
      if (ni < 0) s.pending.delete(id);
      else s.pending.set(id, ni);
    }
  }
}

/** tool_execution_end handler — fill in the matching call's error state. */
export function recordCallEnd(e: EndEvent, sid?: string): void {
  const s = bucket(sid);
  const idx = s.pending.get(e.toolCallId);
  if (idx !== undefined && s.calls[idx]) {
    s.calls[idx]!.isError = e.isError;
    s.pending.delete(e.toolCallId);
  } else {
    // No matching start (defensive) — still record the success/failure fact.
    s.calls.push({ toolName: e.toolName, argsSig: "(end-only)", isError: e.isError, ts: Date.now() });
  }
}

/** Snapshot of the recent call log (most-recent last), bounded to MAX_CALLS. */
export function getCalls(sid?: string): ToolCallRecord[] {
  return bucket(sid).calls.slice(-MAX_CALLS);
}

/** turn_end handler — track completed-turn count (turnIndex is 0-based). */
export function recordTurnEnd(e: { turnIndex: number }, sid?: string): void {
  bucket(sid).turnCount = e.turnIndex + 1;
}

/** Completed-turn count so far, or null if no turn has ended (print mode / pre-first-turn). */
export function getTurnCount(sid?: string): number | null {
  return bucket(sid).turnCount;
}

/** Reset accumulated state. No-arg / undefined = clear ALL buckets (session_start
 *  full-reset + tests); a string sid = delete just that session's bucket (per-session
 *  teardown, e.g. session_shutdown). */
export function resetAccumulator(sid?: string): void {
  if (sid === undefined) {
    states.clear();
  } else {
    states.delete(sid);
  }
}
