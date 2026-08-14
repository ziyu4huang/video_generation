import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type BudgetSessionSurface,
  createBudgetGuard,
  createTurnGuard,
  type TurnSessionSurface,
  turnExhaustionError,
} from "../src/agent.js";
import { WorkflowErrorCode, WorkflowError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// createTurnGuard semantics over a minimal fake session: one turn = one
// prompt→assistant-response cycle in the run loop, delimited by the session's
// turn_start/turn_end events. Exactly maxTurns turns are allowed; the session
// is aborted BEFORE the model is asked for turn maxTurns+1.
// ---------------------------------------------------------------------------

/** Minimal session double: records aborts. */
function fakeTurnSession() {
  const aborts: number[] = [];
  const session: TurnSessionSurface = {
    abort: () => {
      aborts.push(1);
    },
  };
  return { session, aborts };
}

/** The session event that starts a turn (fires before the assistant API call). */
const turnStart = () => ({ type: "turn_start" });

/** The session event that ends a turn (assistant response + its tool results). */
const turnEnd = () => ({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });

/** Feed the guard one full turn (start → end). */
function runTurn(guard: ReturnType<typeof createTurnGuard>) {
  guard.onSessionEvent(turnStart());
  guard.onSessionEvent(turnEnd());
}

test("exactly N turns allowed; abort fires on the turn_start of turn N+1, not before", () => {
  const { session, aborts } = fakeTurnSession();
  const guard = createTurnGuard(session, { maxTurns: 3 });

  runTurn(guard);
  runTurn(guard);
  runTurn(guard);
  assert.equal(guard.turnsUsed, 3);
  assert.equal(guard.exhaustion, undefined); // all 3 turns completed, no abort
  assert.equal(aborts.length, 0);

  // Turn 4 is about to start (the loop continued past the cap) → abort BEFORE it.
  guard.onSessionEvent(turnStart());
  assert.deepEqual(guard.exhaustion, { maxTurns: 3, turnsUsed: 3 });
  assert.equal(aborts.length, 1);
});

test("a run that finishes naturally within the cap is never aborted", () => {
  const { session, aborts } = fakeTurnSession();
  const guard = createTurnGuard(session, { maxTurns: 3 });

  // 3 turns, then the final assistant response ends the loop — no turn 4 starts.
  runTurn(guard);
  runTurn(guard);
  runTurn(guard);
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);
  assert.equal(guard.turnsUsed, 3);
});

test("maxTurns: 1 allows the first turn, aborts the second turn_start", () => {
  const { session, aborts } = fakeTurnSession();
  const guard = createTurnGuard(session, { maxTurns: 1 });

  runTurn(guard);
  assert.equal(guard.exhaustion, undefined);

  guard.onSessionEvent(turnStart());
  assert.deepEqual(guard.exhaustion, { maxTurns: 1, turnsUsed: 1 });
  assert.equal(aborts.length, 1);
});

test("no maxTurns configured → unlimited turns, never aborts", () => {
  const { session, aborts } = fakeTurnSession();
  const guard = createTurnGuard(session, {});

  for (let i = 0; i < 50; i++) runTurn(guard);
  assert.equal(guard.turnsUsed, 50);
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);
});

test("non-turn events are ignored for counting", () => {
  const { session, aborts } = fakeTurnSession();
  const guard = createTurnGuard(session, { maxTurns: 2 });

  guard.onSessionEvent({ type: "message_end", message: { role: "assistant", usage: { total: 5 } } });
  guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
  guard.onSessionEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
  assert.equal(guard.turnsUsed, 0);
  assert.equal(aborts.length, 0);
});

test("idempotent: after the cap fires, later events never double-abort", () => {
  const { session, aborts } = fakeTurnSession();
  const guard = createTurnGuard(session, { maxTurns: 1 });

  runTurn(guard);
  guard.onSessionEvent(turnStart());
  const first = guard.exhaustion;
  assert.ok(first);

  guard.onSessionEvent(turnEnd());
  guard.onSessionEvent(turnStart());
  assert.equal(guard.exhaustion, first); // record unchanged
  assert.equal(aborts.length, 1); // exactly one abort
});

// ---------------------------------------------------------------------------
// Error surface: turnExhaustionError — the distinct TURNS_EXHAUSTED WorkflowError
// CoreAgent.run throws after a turn-cap abort (same mechanics as the budget
// guard's post-prompt throw, different code + details).
// ---------------------------------------------------------------------------

test("turnExhaustionError: message, code, recoverable, agentLabel, details shape", () => {
  const err = turnExhaustionError({ maxTurns: 4, turnsUsed: 4 }, "impl");
  assert.ok(err instanceof WorkflowError);
  assert.equal(err.message, "max turns exceeded (4)");
  assert.equal(err.code, WorkflowErrorCode.TURNS_EXHAUSTED);
  assert.equal(err.recoverable, false);
  assert.equal(err.agentLabel, "impl");
  assert.deepEqual(err.details, { maxTurns: 4, turnsUsed: 4 });
});

test("turnExhaustionError: TURNS_EXHAUSTED is distinct from TOKEN_BUDGET_EXHAUSTED", () => {
  const err = turnExhaustionError({ maxTurns: 2, turnsUsed: 2 });
  assert.notEqual(err.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
});

// ---------------------------------------------------------------------------
// Interaction: the turn cap and the budget guard are wired to the SAME session
// event stream in CoreAgent.run but hold independent state — either can fire
// alone, and one firing never suppresses or misclassifies the other.
// ---------------------------------------------------------------------------

/** Combined double satisfying both guard surfaces; records aborts. */
function fakeCombinedSession(stats: () => { tokens: { total: number }; cost: number }) {
  const aborts: number[] = [];
  const session: BudgetSessionSurface = {
    abort: () => {
      aborts.push(1);
    },
    getSessionStats: stats,
  };
  return { session, aborts };
}

/** A usage observation: one assistant API response finished, carrying usage. */
const usageObservation = (total: number) => ({
  type: "message_end",
  message: { role: "assistant", usage: { total } },
});

test("turn cap fires while the budget stays under its limit", () => {
  let total = 10;
  const { session, aborts } = fakeCombinedSession(() => ({ tokens: { total }, cost: 0 }));
  const budget = createBudgetGuard(session, { tokenBudget: 1000 });
  const turns = createTurnGuard(session, { maxTurns: 2 });

  const feed = (event: unknown) => {
    budget.onSessionEvent(event);
    turns.onSessionEvent(event);
  };

  runTurn({ onSessionEvent: feed });
  runTurn({ onSessionEvent: feed });
  feed(turnStart()); // turn 3 — over the turn cap, budget still fine
  assert.equal(budget.exhaustion, undefined); // budget never fired
  assert.deepEqual(turns.exhaustion, { maxTurns: 2, turnsUsed: 2 });
  assert.equal(aborts.length, 1); // one abort (from the turn guard)
});

test("budget fires while the turn count stays under its cap", () => {
  let total = 10;
  const { session, aborts } = fakeCombinedSession(() => ({ tokens: { total }, cost: 0 }));
  const budget = createBudgetGuard(session, { tokenBudget: 1000 });
  const turns = createTurnGuard(session, { maxTurns: 50 });

  const feed = (event: unknown) => {
    budget.onSessionEvent(event);
    turns.onSessionEvent(event);
  };

  feed(turnStart());
  total = 5000; // cumulative usage blows past the budget mid-turn
  feed(usageObservation(5000));
  feed(turnEnd());
  assert.deepEqual(budget.exhaustion, { kind: "tokens", limit: 1000, actual: 5000 });
  assert.equal(turns.exhaustion, undefined); // turn cap never fired
  assert.equal(aborts.length, 1); // one abort (from the budget guard)
});
