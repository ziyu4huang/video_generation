/**
 * #04 retry-loop / runaway detector — pure helpers.
 *
 * Motivation (run history: 6× "durable memory" retries): a semantically-identical
 * task dispatched repeatedly fails the same way each time, burning tokens on each
 * retry. `retryOnTransient` already retries ONCE inside a single dispatch (a
 * fresh tryOnce() on a transient timeout/network/schema flake) — that is correct
 * and UNCHANGED. This detector operates one level UP: it counts COMPLETED
 * dispatch OUTCOMES (persisted records), and if the same task signature has
 * failed with the same failure class N times in a row (within a time window), the
 * NEXT dispatch is circuit-broken BEFORE spawn.
 *
 * Default threshold N=2: after 2 consecutive identical failures, the 3rd attempt
 * is blocked. (The in-dispatch retryOnTransient retry does NOT count here — it
 * produces a single record per dispatch.)
 *
 * All functions are pure and take a `SubagentRunRecord[]` snapshot the caller
 * supplies (persistence.list(), newest-first), so this module has no I/O and is
 * fully unit-testable.
 */
import type { SubagentRunRecord } from "@repo/s2-agent-core-runtime";

/** Default: circuit-break after this many consecutive identical failures. */
export const DEFAULT_RETRY_CIRCUIT_BREAK = 2;

/** Window over which consecutive failures are counted (ms). 10 min. */
export const RETRY_LOOP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Canonical, case-insensitive, whitespace-collapsed form of a task prompt — two
 * prompts that differ only in casing/whitespace collapse to the SAME signature
 * (the recurring failure mode is the same task re-dispatched with trivial edits).
 * Reuses taskPreview's normalization idea (single-line) but does NOT truncate,
 * so the full intent is part of the signature.
 */
export function taskSignature(task: string): string {
  return task.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A failure's semantic class: `status:error` (error text trimmed). The text is
 * bucketed as-is (the recurring loops had byte-identical error text); two
 * records with the same status and same error text are "identical". An empty
 * string is returned for NON-failures (done/aborted are not loop signals).
 *
 * The parameter is structural and its text field optional, so a rename on
 * SubagentRunRecord passes tsc while silently collapsing every failure into one
 * bucket — which would trip the circuit breaker on a task that never looped.
 * `tests/retry-loop-detector.test.ts` pins the field name against exactly that.
 */
export function failureClass(record: { status: string; error?: string }): string {
  // Only real failure modes constitute a loop; done/aborted reset the streak.
  if (record.status !== "failed" && record.status !== "timedout" && record.status !== "budget") return "";
  return `${record.status}:${(record.error ?? "").trim()}`;
}

/**
 * Count, newest-first, how many CONSECUTIVE records match BOTH `signature` and
 * `fclass` within the last `windowMs`. The streak stops at the first record that
 * differs in either (a different failure class or a different task resets it) or
 * that falls outside the window. Non-matching records that are newer are skipped
 * (they don't break the streak — only the first matching record's window anchors
 * the count). Returns 0 when nothing matches.
 */
export function consecutiveIdenticalFailures(
  records: SubagentRunRecord[],
  signature: string,
  fclass: string,
  windowMs: number,
): number {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  let anchored = false;
  for (const r of records) {
    const startedAt = new Date(r.startedAt).getTime();
    if (Number.isNaN(startedAt)) continue;
    if (startedAt < cutoff) break; // list is newest-first → older than this is out of window
    const matches = taskSignature(r.task) === signature && failureClass(r) === fclass;
    if (matches) {
      anchored = true;
      count++;
    } else if (anchored) {
      // We've started counting and hit a non-match → the identical streak is broken.
      break;
    }
    // else: pre-anchor non-match → skip (don't break; keep scanning for the first match).
  }
  return count;
}

/** True when the consecutive-identical count reaches the threshold (default 2). */
export function shouldCircuitBreak(count: number, threshold: number = DEFAULT_RETRY_CIRCUIT_BREAK): boolean {
  return count >= threshold;
}
