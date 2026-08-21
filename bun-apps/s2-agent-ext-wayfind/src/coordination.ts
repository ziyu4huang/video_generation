/**
 * Coordination seam — wayfind ⇄ plan coordinator (reverse reads only).
 *
 * wayfind has NO forward coordination seam: mutual-exclusion between a
 * grill/wayfinder session and /goal or /loop is user-initiated (run one driver
 * at a time). The published `__piWayfindGrill` sibling IS consumed (by
 * hermes-memory); the reverse seam is `__piPlanPhases` alone (read by
 * chain.ts syncChainState — see constants.ts). The plan-incomplete/summary readers were DEAD (no production
 * caller) and were removed 2026-08-21 with their publisher + registry entries (D1).
 *
 * Why globalThis and not an import? pi loads extensions via jiti, and module
 * identity across a jiti-loaded extension and a native `import()` from this
 * package is NOT guaranteed — the plan coordinator's published singleton might
 * be a different copy, so an imported reader could always return false (silent
 * gate failure). `globalThis` is process-singleton → always the live value.
 * Graceful fallback: if either side is absent, the globals are undefined → false.
 */

import { WAYFIND_GRILL_KEY } from "./constants.js";
import type { RuntimeState } from "./state.js";

/** Publish the grill-specific active reader. Closure reads live RuntimeState. */
export function publishWayfindGrill(state: RuntimeState): void {
  (globalThis as Record<string, unknown>)[WAYFIND_GRILL_KEY] = (sessionId: string) =>
    state.activeGrillBySession.has(sessionId);
}

/** Remove the grill reader (session_shutdown / unload). */
export function unpublishWayfindGrill(): void {
  delete (globalThis as Record<string, unknown>)[WAYFIND_GRILL_KEY];
}

/** Read whether a GRILL (not wayfinder) is active for this session.
 *  Graceful: false when wayfind is absent or no grill is active. */
export function readWayfindGrill(sessionId: string): boolean {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[WAYFIND_GRILL_KEY];
  return typeof fn === "function" ? (fn as (id: string) => boolean)(sessionId) : false;
}
