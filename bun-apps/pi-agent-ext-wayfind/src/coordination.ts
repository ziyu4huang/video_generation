/**
 * Coordination seam — wayfind ⇄ planning-with-files.
 *
 * Mirrors pi-agent-ext-planning-with-files/src/coordination.ts (the goal seam).
 *
 * Why globalThis and not an import? pi loads extensions via jiti, and module
 * identity across a jiti-loaded extension and a native `import()` from this
 * package is NOT guaranteed — planning-with-files' published singleton might be a
 * different copy, so an imported `isWayfindActive()` could always return false
 * (silent gate failure). `globalThis` is process-singleton → always the live value.
 * Graceful fallback: if either side is absent, the globals are undefined → false.
 */

import { PLAN_INCOMPLETE_KEY, PLAN_SUMMARY_KEY, WAYFIND_ACTIVE_KEY } from "./constants.js";
import { isAnyWayfindSessionActive, type RuntimeState } from "./state.js";

/** Publish the "is a wayfind session active" reader so planning-with-files can
 *  yield during a live grill. The closure reads the live RuntimeState, so it
 *  always returns the current value without re-publishing. */
export function publishWayfindActive(state: RuntimeState): void {
  (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY] = () => isAnyWayfindSessionActive(state);
}

/** Remove the published reader (called on session_shutdown / when wayfind is
 *  unloaded). Leaves globalThis clean so a stale closure can't lie. */
export function unpublishWayfindActive(): void {
  delete (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY];
}

/** Read whether planning-with-files reports an incomplete plan in `cwd`.
 *  Graceful: false when planning-with-files is absent or has no plan. */
export function readPlanIncomplete(cwd: string): boolean {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[PLAN_INCOMPLETE_KEY];
  return typeof fn === "function" ? (fn as (cwd: string) => boolean)(cwd) : false;
}

/** Read planning-with-files' one-line plan summary (for wayfind narration).
 *  Graceful: empty string when absent. */
export function readPlanSummary(cwd: string): string {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[PLAN_SUMMARY_KEY];
  return typeof fn === "function" ? (fn as (cwd: string) => string)(cwd) : "";
}

/** Standalone reader of our own published seam (used by tests + self-check). */
export function isWayfindActivePublished(): boolean {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[WAYFIND_ACTIVE_KEY];
  return typeof fn === "function" ? (fn as () => boolean)() : false;
}
