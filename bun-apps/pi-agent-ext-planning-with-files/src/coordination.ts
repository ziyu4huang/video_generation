/**
 * Plan A coordination seam — goal ⇄ planning-with-files mutual-exclusion.
 *
 * Reads power-tool's published `globalThis.__piGoalActive` to decide whether
 * planning-with-files should YIELD its plan injection / auto-continue to an
 * active /goal (which owns iteration counting, token budget, and recovery).
 *
 * Phase 4 extension: also reads pi-agent-ext-wayfind's published
 * `globalThis.__piWayfindActive` — an active grill / wayfinder session owns the
 * turn the same way /goal does, so planning yields to it too (avoids the
 * plan-injection + grilling-interview double-drive). Same globalThis rationale.
 *
 * Why globalThis and not a static import? pi loads extensions via jiti, and
 * module identity across a jiti-loaded extension and a native `import()` from
 * this package is NOT guaranteed — power-tool's singleton `activeGoal` might be
 * a different copy, so an imported `isGoalActive()` could always return false
 * (silent gate failure). `globalThis` is process-singleton → always the live
 * value published from power-tool's actual factory instance.
 *
 * Graceful fallback: if power-tool / wayfind is absent (planning-with-files
 * used standalone, per its README/PRD), the global is undefined → returns false
 * → planning behaves exactly as before. No hard dependency.
 */

const GOAL_ACTIVE_KEY = "__piGoalActive";
const WAYFIND_ACTIVE_KEY = "__piWayfindActive";

export function isGoalActive(): boolean {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[GOAL_ACTIVE_KEY];
  return typeof fn === "function" ? (fn as () => boolean)() : false;
}

/** Whether an active grill / wayfinder session (pi-agent-ext-wayfind) is driving
 *  the turn. planning-with-files yields to it, mirroring the /goal yield. */
export function isWayfindActive(): boolean {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[WAYFIND_ACTIVE_KEY];
  return typeof fn === "function" ? (fn as () => boolean)() : false;
}

/** Either external driver (goal or wayfind) is active → planning yields. */
export function isExternalDriverActive(): boolean {
  return isGoalActive() || isWayfindActive();
}
