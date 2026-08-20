import type { SeamKey } from "./seam-keys.js";
import type { KnowledgePipeline } from "./interfaces/knowledge-pipeline.js";

/**
 * Live tool-gate state (wayfinder ticket 06) — what the power-tool
 * inspect_context "tool gate" section renders. Published by tool-gate via the
 * __piToolGateStatus seam; shape is the contract both sides share (kept here in
 * core-interface so the type is importable without crossing packages).
 */
export interface ToolGateStatus {
  /** Session id the state belongs to ("" when none — pre-session host). */
  sessionId: string;
  /** Active (not gated-out) tool count at session start. */
  activeCount: number;
  /** Total tool count. */
  totalCount: number;
  /** The always-on (core) tool count. */
  coreCount: number;
  /** Per gate family: fired/dormant + keywords + measured token cost. */
  gates: {
    id: string;
    names: string[];
    /** True iff EVERY name in the family is currently sticky (fired). */
    fired: boolean;
    /** True iff ANY name is still dormant (not yet sticky). */
    dormant: boolean;
    keywords: string[];
    tokens: number;
  }[];
  /** The session's sticky set (core + every fired gate name). */
  sticky: string[];
}

/** key -> implementation type. KnowledgePipeline + ToolGateStatus typed now;
 *  the other __pi* seams typed `unknown` (incremental migration — ticket 11
 *  fork 3). __piRateLimitState is also `unknown` here — it is NEVER published/
 *  read via publishSeam/readSeam (its globalThis slot is owned directly by
 *  s2-agent-core-runtime's rate-limiter via its own GLOBAL_KEY); it is
 *  registered in SEAM_KEYS purely to satisfy the seam-contract NO-ORPHANS
 *  invariant. */
export interface SeamImplMap {
  __piKnowledgePipeline: KnowledgePipeline;
  __piToolGateStatus: () => ToolGateStatus | undefined;
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
   *  duplicated literal (ADR-wayfind-0004). Typed `unknown` and present here only so
   *  SeamImplMap stays total over SeamKey. */
  __piHermesStaleCheck: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __piKnowledgePipeline: KnowledgePipeline | undefined;
  // eslint-disable-next-line no-var
  var __piToolGateStatus: (() => ToolGateStatus | undefined) | undefined;
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
