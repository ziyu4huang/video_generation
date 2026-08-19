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
  /** The caller-declared ceiling on prompt→response turns. Optional only on the
   *  success surface (an unlimited done run reports turnsUsed with no cap) —
   *  abort paths (the `turns` failure kind) always set it. */
  maxTurns?: number;
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
 * Minimal session surface the wrap-up nudge needs (real AgentSession or a
 * test double): the SDK's steering queue, public as `steer(text, images?)` on
 * AgentSession — "Delivered after the current assistant turn finishes
 * executing its tool calls, before the next LLM call" (agent-session.d.ts
 * ~L364-370). Narrowed here so this module never imports the SDK type
 * (portability) and unit tests can pass a minimal fake.
 */
export interface SteeringCapableSession {
  steer(text: string): Promise<unknown>;
}

/**
 * The default wrap-up nudge text (English), with the cap interpolated so the
 * model knows exactly how much runway is left.
 */
export function wrapUpNudgeText(maxTurns: number): string {
  return `[dispatch] Wrap-up notice: your next turn is the last before the turns cap (${maxTurns}). Stop starting new work — finish the current step minimally, then produce your final report (include the commit sha if you committed).`;
}

/** The AgentRunOptions fields the wrap-up nudge reads. */
export interface WrapUpNudgeOptions {
  /** See AgentRunOptions.maxTurns: the nudge only exists on capped runs. */
  maxTurns?: number;
  /** true/undefined = enabled when maxTurns >= 2; false disables; string overrides the nudge text. */
  wrapUpNudge?: boolean | string;
}

/** One-shot wrap-up nudge queue (see createWrapUpNudgeQueue). */
export interface WrapUpNudgeQueue {
  /** Route a session event + the turn guard's current turnsUsed; fires steer() at most once. */
  onSessionEvent(event: unknown, turnsUsed: number): void;
}

/**
 * One-shot last-turn wrap-up nudge for turn-capped runs. Turns-abort is the
 * top killer in the dispatch ledger (capped subagents hard-abort at turn
 * maxTurns+1 with work in flight — salvage shows near-complete work); this
 * converts those deaths into completions. At the turn_start of the
 * SECOND-TO-LAST turn (turnsUsed === maxTurns - 2, since at turn_start of turn
 * T the guard has counted T-1 turn_ends) it queues the nudge text via the
 * session's steering method, which delivers it at the idle boundary AFTER that
 * turn's tool calls — so the model spends its ENTIRE final turn finalizing +
 * reporting instead of dying mid-step. The hard cap (TurnGuard abort) stays as
 * the backstop. Enabled by default whenever maxTurns is defined and >= 2
 * (maxTurns === 1 has no second-to-last turn to save — nothing fires;
 * maxTurns === 2 queues at the first turn's start, which is correct). One-shot:
 * once steer() has been called, later events are ignored. Unit-testable with a
 * minimal fake session, mirroring createTurnGuard.
 */
export function createWrapUpNudgeQueue(session: SteeringCapableSession, options: WrapUpNudgeOptions): WrapUpNudgeQueue {
  // The turn whose turn_start triggers the queue: undefined = disabled
  // (wrapUpNudge:false, no cap, or a cap with no second-to-last turn).
  const triggerTurns =
    options.wrapUpNudge !== false && options.maxTurns !== undefined && options.maxTurns >= 2
      ? options.maxTurns - 2
      : undefined;
  let queued = false;
  return {
    onSessionEvent(event, turnsUsed) {
      if (triggerTurns === undefined || queued || !isTurnStartObservation(event)) return;
      if (turnsUsed !== triggerTurns) return;
      queued = true;
      const text = typeof options.wrapUpNudge === "string" ? options.wrapUpNudge : wrapUpNudgeText(triggerTurns + 2);
      // Fire-and-forget: a failed queue must never kill the run — the hard
      // turn cap remains the backstop.
      void session.steer(text).catch(() => {
        // ignored by design
      });
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
