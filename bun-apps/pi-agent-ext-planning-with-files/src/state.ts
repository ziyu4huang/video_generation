/**
 * Per-session runtime state and session-key helpers.
 *
 * Kept in its own module so `commands.ts` and `runtime.ts` can both consume it
 * without importing each other (which would create a runtime ESM cycle). Only
 * type-only Pi imports live here.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSessionAttached, type PlanStatus } from "./plan.js";

export interface RuntimeState {
  autoContinueCountBySessionPlan: Map<string, number>;
  /** Last-seen `completePhases` per (session, plan). Used by agent_end to detect
   *  real progress: when the complete count strictly increases between fires,
   *  the auto-continue count is reset — a steadily-advancing agent gets a fresh
   *  budget per phase instead of hitting the 3-continue wall mid-task. */
  lastCompletePhasesBySessionPlan: Map<string, number>;
  /** ADR-0001: per (session, plan) the set of ticket-ids whose phase was already
   *  complete at the last agent_end — so a /chain-sync nudge fires exactly once
   *  per newly-complete ticketed phase. */
  lastCompleteTicketPhaseIdsBySessionPlan: Map<string, Set<string>>;
  loopTimersBySession: Map<string, ReturnType<typeof setInterval>>;
  goalBySession: Map<string, string>;
  preToolQueuedByLeaf: Set<string>;
  executionApprovedBySessionPlan: Set<string>;
}

export function createRuntimeState(): RuntimeState {
  return {
    autoContinueCountBySessionPlan: new Map(),
    lastCompletePhasesBySessionPlan: new Map(),
    lastCompleteTicketPhaseIdsBySessionPlan: new Map(),
    loopTimersBySession: new Map(),
    goalBySession: new Map(),
    preToolQueuedByLeaf: new Set(),
    executionApprovedBySessionPlan: new Set(),
  };
}

export function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

export function getPlanSessionKey(ctx: ExtensionContext, status: PlanStatus): string {
  return `${getSessionId(ctx)}:${status.planPath ?? "none"}`;
}

export function isExecutionApproved(state: RuntimeState, ctx: ExtensionContext, status: PlanStatus): boolean {
  return state.executionApprovedBySessionPlan.has(getPlanSessionKey(ctx, status));
}

export function clearSessionPrefixMap(state: RuntimeState, sessionId: string): void {
  for (const key of state.autoContinueCountBySessionPlan.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      state.autoContinueCountBySessionPlan.delete(key);
    }
  }
  for (const key of state.lastCompletePhasesBySessionPlan.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      state.lastCompletePhasesBySessionPlan.delete(key);
    }
  }
  for (const key of state.lastCompleteTicketPhaseIdsBySessionPlan.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      state.lastCompleteTicketPhaseIdsBySessionPlan.delete(key);
    }
  }
  for (const key of Array.from(state.preToolQueuedByLeaf)) {
    if (key.startsWith(`${sessionId}:`)) {
      state.preToolQueuedByLeaf.delete(key);
    }
  }
}

export function clearSessionExecutionApprovals(state: RuntimeState, sessionId: string): void {
  for (const key of state.executionApprovedBySessionPlan.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      state.executionApprovedBySessionPlan.delete(key);
    }
  }
}

export function isAttachedSession(ctx: ExtensionContext): boolean {
  return isSessionAttached(ctx.cwd, getSessionId(ctx));
}
