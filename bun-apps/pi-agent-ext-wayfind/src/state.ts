/**
 * Per-session runtime state and session helpers (mirrors the plan coordinator's
 * state-module pattern). Kept in its own module so commands.ts and index.ts can
 * both consume it without an ESM cycle.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface RuntimeState {
  /** sessionId → the topic string of the active grill (or "(current conversation)").
   *  Presence in this map = a grill session is active for that session. */
  activeGrillBySession: Map<string, string>;
  /** sessionId → active wayfinder effort slug (Phase 3 flesh-out; kept here so the
   *  coordination seam can already see "a wayfinder session is live"). */
  activeEffortBySession: Map<string, string>;
  /** Whether the active grill is the `-with-docs` variant (drives domain-modeling). */
  grillWithDocsBySession: Map<string, boolean>;
}

export function createRuntimeState(): RuntimeState {
  return {
    activeGrillBySession: new Map(),
    activeEffortBySession: new Map(),
    grillWithDocsBySession: new Map(),
  };
}

export type AnyContext = ExtensionContext | ExtensionCommandContext;

export function getSessionId(ctx: AnyContext): string {
  return ctx.sessionManager.getSessionId();
}

/** A grill is active for this session (or any session, for the process-global seam). */
export function isGrillActive(state: RuntimeState, sessionId: string): boolean {
  return state.activeGrillBySession.has(sessionId);
}

/** Process-global: is ANY grill/wayfinder session active? This is what the
 *  coordination seam publishes so the plan coordinator can yield. */
export function isAnyWayfindSessionActive(state: RuntimeState): boolean {
  return state.activeGrillBySession.size > 0 || state.activeEffortBySession.size > 0;
}

/** Clear all state for a session (called on session_shutdown). */
export function clearSession(state: RuntimeState, sessionId: string): void {
  state.activeGrillBySession.delete(sessionId);
  state.activeEffortBySession.delete(sessionId);
  state.grillWithDocsBySession.delete(sessionId);
}
