/**
 * Pathology detector types (F v1).
 *
 * The detector is a PURE function over a typed call-log (PathologyInput), so the
 * three v1 detectors (retry-loop, tool error storm, context saturation) are
 * unit-testable without the SDK or any accumulator.
 */

/**
 * A single observed tool call, as accumulated by the tool_execution_start/end
 * hooks. `argsSig` is a stable, order-independent, length-bounded signature of
 * the call arguments (see detector.argsSig) so two calls with identical args —
 * even if the agent passed them with different key order — compare equal.
 */
export interface ToolCallRecord {
  toolName: string;
  argsSig: string;
  isError: boolean;
  /** epoch ms — used only for ordering/recency; detectors don't read it directly. */
  ts: number;
}

/**
 * Input to analyzePathology(). All threshold fields are optional with sensible
 * defaults so callers can do `analyzePathology({ calls, contextPercent })`.
 */
export interface PathologyInput {
  /** The accumulated, order-preserving call log (most callers pass the whole bounded buffer). */
  calls: ToolCallRecord[];
  /** Live context-window fill percent, or null when no LLM turn has completed. */
  contextPercent: number | null;
  /** Completed-turn count (from turn_end events), or null if unavailable. */
  turnCount?: number | null;

  // ── retry loop ────────────────────────────────────────────────────────────
  /** Identical (tool+args) repeats within the window at/above this count → loop. Default 3. */
  loopRepeatThreshold?: number;
  /** How many trailing calls to scan for loops. Default 30. */
  loopWindowSize?: number;

  // ── tool error storm ───────────────────────────────────────────────────────
  /** Per-tool error rate at/above which an error-storm is flagged. Default 0.5. */
  errorRateThreshold?: number;
  /** Minimum calls a tool must have before its error rate is evaluated. Default 4. */
  errorRateMinCalls?: number;
  /** Longest run of consecutive errors on one tool at/above this → consecutive-error. Default 3. */
  consecutiveErrorThreshold?: number;

  // ── context saturation ─────────────────────────────────────────────────────
  /** Context fill percent at/above which saturation is flagged. Default 85. */
  saturationPercent?: number;

  // ── long-session recall risk (v2, deterministic) ──────────────────────────
  /** Completed-turn count at/above which long-session recall risk is flagged. Default 15. */
  longSessionTurnThreshold?: number;
}
