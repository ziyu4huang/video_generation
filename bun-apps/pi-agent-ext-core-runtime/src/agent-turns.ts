/**
 * Per-run turn-count guard for a subagent session: the turn-boundary
 * detection helpers and the stateful guard that caps prompt→response
 * cycles, plus its error surface.
 *
 * Kept in its own module rather than folded into agent-budget.ts: the two
 * guards are independent by design (neither's exhaustion affects the
 * other, no shared helper) and agent-budget.ts's zero-import property
 * is a deliberate structural invariant for that module — merging the guards
 * would tempt a shared helper and couple state that must stay independent.
 */
import { WorkflowError, WorkflowErrorCode } from "./errors.js";

/** Minimal session surface the turn guard needs (real AgentSession or a test double): mid-run abort. */
export interface TurnSessionSurface {
  abort(): unknown;
}

/** Why a turn-capped subagent run was aborted before its next turn. */
export interface TurnExhaustion {
  /** The caller-declared ceiling on prompt→response turns. */
  maxTurns: number;
  /** Turns completed when the abort fired (== maxTurns). */
  turnsUsed: number;
}

/** Detect the session event that delimits the start of a turn (one assistant API response cycle). */
export function isTurnStartObservation(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "turn_start";
}

/** Detect the session event that delimits the end of a turn (assistant response + its tool results). */
export function isTurnEndObservation(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "turn_end";
}

/**
 * Per-run turn cap: aborts the session BEFORE the model is asked for turn
 * maxTurns+1. One turn = one prompt→assistant-response cycle in the run loop,
 * delimited by the session's turn_start/turn_end events (the SDK emits
 * turn_start before each assistant API response, turn_end after its tool
 * results). A run that naturally finishes within maxTurns turns is never
 * aborted — only a loop that would CONTINUE past the cap is stopped. Idempotent:
 * after the abort fires once, later events are ignored. Distinct from the
 * budget guard: independent state, no shared classification.
 */
export interface TurnGuard {
  /** The exhaustion record once the cap fired; undefined before. */
  readonly exhaustion: TurnExhaustion | undefined;
  /** Turns completed so far (turn_end events observed). */
  readonly turnsUsed: number;
  /** Route a session event: turn_start → pre-turn cap check, turn_end → count. */
  onSessionEvent(event: unknown): void;
}

/**
 * Build a TurnGuard over a session. Module-level and session-injected so the
 * cap semantics (exactly N allowed, abort before N+1, idempotence, natural-
 * finish-within-cap) are unit-testable with a minimal fake session, independent
 * of CoreAgent.run / createAgentSession.
 */
export function createTurnGuard(session: TurnSessionSurface, options: { maxTurns?: number }): TurnGuard {
  let turnsUsed = 0;
  let exhaustion: TurnExhaustion | undefined;
  return {
    get exhaustion() {
      return exhaustion;
    },
    get turnsUsed() {
      return turnsUsed;
    },
    onSessionEvent(event: unknown) {
      if (exhaustion) return; // idempotent: one abort, no double-fire
      if (isTurnStartObservation(event)) {
        // Turn maxTurns+1 is about to start (an assistant API call): abort BEFORE
        // it runs. turnsUsed < maxTurns here means the cap hasn't been reached.
        if (options.maxTurns !== undefined && turnsUsed >= options.maxTurns) {
          exhaustion = { maxTurns: options.maxTurns, turnsUsed };
          void session.abort();
        }
      } else if (isTurnEndObservation(event)) {
        turnsUsed++;
      }
    },
  };
}

/**
 * The distinct error surface for a turn-capped abort: non-recoverable (retrying
 * would re-burn the same turns), carrying {maxTurns, turnsUsed} in details.
 * Extracted from CoreAgent.run so the message/shape is unit-testable.
 */
export function turnExhaustionError(exhaustion: TurnExhaustion, label?: string): WorkflowError {
  return new WorkflowError(`max turns exceeded (${exhaustion.maxTurns})`, WorkflowErrorCode.TURNS_EXHAUSTED, {
    recoverable: false,
    agentLabel: label,
    details: exhaustion,
  });
}
