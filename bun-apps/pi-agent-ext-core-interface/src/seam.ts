import type { SeamKey } from "./seam-keys.js";
import type { KnowledgePipeline } from "./interfaces/knowledge-pipeline.js";

/** key -> implementation type. KnowledgePipeline typed now; the 7 existing
 *  __pi* seams typed `unknown` (incremental migration — ticket 11 fork 3).
 *  __piRateLimitState is also `unknown` here — it is NEVER published/read via
 *  publishSeam/readSeam (its globalThis slot is owned directly by
 *  pi-agent-ext-core-runtime's rate-limiter via its own GLOBAL_KEY); it is registered
 *  in SEAM_KEYS purely to satisfy the seam-contract NO-ORPHANS invariant. */
export interface SeamImplMap {
  __piKnowledgePipeline: KnowledgePipeline;
  __piCoreTaskStatusWidget: unknown;
  __piGoalActive: unknown;
  __piKickHeartbeat: unknown;
  __piPlanIncomplete: unknown;
  __piPlanPhases: unknown;
  __piPlanSummary: unknown;
  __piWayfindGrill: unknown;
  __piRateLimitState: unknown;
  /** Like __piRateLimitState, never published/read through publishSeam/readSeam
   *  — hermes-memory and wayfind own the globalThis slot directly via their own
   *  duplicated literal (ADR-0004). Typed `unknown` and present here only so
   *  SeamImplMap stays total over SeamKey. */
  __piHermesStaleCheck: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __piKnowledgePipeline: KnowledgePipeline | undefined;
}

/** Publish a seam impl to globalThis. key is a typed SeamKey union, so an
 *  unregistered key (e.g. "__piFoo") is a COMPILE error — orphan prevention. */
export function publishSeam<K extends SeamKey>(key: K, impl: SeamImplMap[K]): void {
  (globalThis as Record<string, unknown>)[key] = impl;
}

/** Read a seam impl defensively. Returns undefined if unpublished. */
export function readSeam<K extends SeamKey>(key: K): SeamImplMap[K] | undefined {
  return (globalThis as Record<string, unknown>)[key] as SeamImplMap[K] | undefined;
}
