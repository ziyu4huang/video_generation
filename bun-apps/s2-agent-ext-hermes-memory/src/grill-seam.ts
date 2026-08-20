/**
 * hermes-memory's reader of wayfind's GRILL-SPECIFIC active seam.
 *
 * The key literal is duplicated from s2-agent-ext-wayfind/src/constants.ts
 * (WAYFIND_GRILL_KEY = "__piWayfindGrill") because globalThis is the contract —
 * a cross-extension `import` is not reliable under jiti (see wayfind's
 * coordination.ts comment). If wayfind is absent or no grill is active, this
 * returns false and the correction-detector runs normally.
 */
const WAYFIND_GRILL_KEY = "__piWayfindGrill";

export function readGrillActive(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const fn = (globalThis as Record<string, unknown> | undefined)?.[WAYFIND_GRILL_KEY];
  return typeof fn === "function" ? (fn as (id: string) => boolean)(sessionId) : false;
}
