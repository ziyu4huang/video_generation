import type { SeamKey } from "./seam-keys.js";
import type { KnowledgePipeline } from "./interfaces/knowledge-pipeline.js";

/** key -> implementation type. KnowledgePipeline typed now; the 7 existing
 *  __pi* seams typed `unknown` (incremental migration — ticket 11 fork 3). */
export interface SeamImplMap {
  __piKnowledgePipeline: KnowledgePipeline;
  __piCoreTaskStatusWidget: unknown;
  __piGoalActive: unknown;
  __piKickHeartbeat: unknown;
  __piPlanIncomplete: unknown;
  __piPlanPhases: unknown;
  __piPlanSummary: unknown;
  __piWayfindGrill: unknown;
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
