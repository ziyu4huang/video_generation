/**
 * Behavioral probe harness — shared types + the pass/fail tolerance gate.
 *
 * Consumed by every phase (subagent schema slim, wayfind skill thinning, skill
 * unload audit). The `Probe`/`ProbeResult`/`passed()` contract is the stable
 * surface later tasks reuse; the runner's dispatch mechanism is a means to that
 * end and may be swapped (standalone script vs workflow tool) without touching
 * probe modules.
 */

/** A behavioral probe — one scenario to run + how to judge it. */
export interface Probe {
  id: string;
  phase: 1 | 2 | 3;
  /** The scenario prompt, handed to an isolated subagent. */
  prompt: string;
  /** Behavioral checklist — the judge scores each 0–3. */
  rubric: string[];
  /** Machine checks: each regex must match the subagent's transcript/output. */
  structural?: RegExp[];
}

/** One probe's scored outcome. */
export interface ProbeResult {
  id: string;
  rubricScores: number[]; // aligned to probe.rubric, 0–3 each
  structuralPassed: boolean;
  judgeNotes: string;
  output: string; // the subagent's full output (for diffing)
}

/**
 * Pass if every rubric item ≥ baseline − 1 (tolerance) AND structural passed.
 *
 * Tolerance rationale: judge scores are noisy (±1 per item is within
 * inter-run variance for an LLM grader). A slim that drops every item by exactly
 * 1 is "no worse within noise"; a drop of 2+ on any item is a real regression.
 * Structural checks are hard gates (a missing tool invocation is never "noise").
 */
export function passed(result: ProbeResult, baseline: ProbeResult | undefined): boolean {
  if (!result.structuralPassed) return false;
  if (!baseline) return true;
  return result.rubricScores.every((s, i) => s >= (baseline.rubricScores[i] ?? 0) - 1);
}
