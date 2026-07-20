/**
 * Hook-fed call accumulator (module-scoped bounded buffer).
 *
 * The factory registers recordCallStart/recordCallEnd on the SDK's
 * tool_execution_start / tool_execution_end events. Each (toolName, args,
 * isError) observation is appended here; analyzePathology() reads the buffer at
 * call time via getCalls(). State is reset on session_start so each session's
 * diagnostics are self-contained.
 *
 * Module-scoped (not a class) to mirror the core-task accumulator pattern
 * already proven in this repo. Memory is bounded by MAX_CALLS via a soft cap
 * that slices the oldest entries when the buffer grows to 2× the cap (indices in
 * `pending` are re-based accordingly).
 */
import { argsSig } from "./detector.ts";
import type { ToolCallRecord } from "./types.ts";

const MAX_CALLS = 500;

let calls: ToolCallRecord[] = [];
/** toolCallId → index in `calls` awaiting its tool_execution_end. */
const pending = new Map<string, number>();

/** Completed-turn count (from turn_end events); null before any turn ends. */
let turnCount: number | null = null;

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
export function recordCallStart(e: StartEvent): void {
  const rec: ToolCallRecord = {
    toolName: e.toolName,
    argsSig: argsSig(e.args),
    isError: false,
    ts: Date.now(),
  };
  pending.set(e.toolCallId, calls.length);
  calls.push(rec);
  // Soft cap: drop the oldest slice and re-base pending indices.
  if (calls.length > MAX_CALLS * 2) {
    const drop = calls.length - MAX_CALLS;
    calls = calls.slice(drop);
    for (const [id, i] of pending) {
      const ni = i - drop;
      if (ni < 0) pending.delete(id);
      else pending.set(id, ni);
    }
  }
}

/** tool_execution_end handler — fill in the matching call's error state. */
export function recordCallEnd(e: EndEvent): void {
  const idx = pending.get(e.toolCallId);
  if (idx !== undefined && calls[idx]) {
    calls[idx]!.isError = e.isError;
    pending.delete(e.toolCallId);
  } else {
    // No matching start (defensive) — still record the success/failure fact.
    calls.push({ toolName: e.toolName, argsSig: "(end-only)", isError: e.isError, ts: Date.now() });
  }
}

/** Snapshot of the recent call log (most-recent last), bounded to MAX_CALLS. */
export function getCalls(): ToolCallRecord[] {
  return calls.slice(-MAX_CALLS);
}

/** turn_end handler — track completed-turn count (turnIndex is 0-based). */
export function recordTurnEnd(e: { turnIndex: number }): void {
  turnCount = e.turnIndex + 1;
}

/** Completed-turn count so far, or null if no turn has ended (print mode / pre-first-turn). */
export function getTurnCount(): number | null {
  return turnCount;
}

/** Reset all accumulated state (session_start / tests). */
export function resetAccumulator(): void {
  calls = [];
  pending.clear();
  turnCount = null;
}
