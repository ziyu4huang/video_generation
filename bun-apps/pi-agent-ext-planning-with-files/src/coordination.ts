/**
 * Plan A coordination seam — goal ⇄ planning-with-files mutual-exclusion.
 *
 * Reads power-tool's published `globalThis.__piGoalActive` to decide whether
 * planning-with-files should YIELD its plan injection / auto-continue to an
 * active /goal (which owns iteration counting, token budget, and recovery).
 *
 * Why globalThis and not a static import? pi loads extensions via jiti, and
 * module identity across a jiti-loaded extension and a native `import()` from
 * this package is NOT guaranteed — power-tool's singleton `activeGoal` might be
 * a different copy, so an imported `isGoalActive()` could always return false
 * (silent gate failure). `globalThis` is process-singleton → always the live
 * value published from power-tool's actual factory instance.
 *
 * Graceful fallback: if power-tool is absent (planning-with-files used
 * standalone, per its README/PRD), the global is undefined → returns false →
 * planning behaves exactly as before. No hard dependency.
 */

const GOAL_ACTIVE_KEY = "__piGoalActive";

export function isGoalActive(): boolean {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[GOAL_ACTIVE_KEY];
  return typeof fn === "function" ? (fn as () => boolean)() : false;
}
