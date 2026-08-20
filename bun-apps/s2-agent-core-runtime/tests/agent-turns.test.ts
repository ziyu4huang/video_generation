import { test } from "bun:test";
import assert from "node:assert/strict";
import { CoreAgent } from "../src/agent.js";
import { type BudgetSessionSurface, createBudgetGuard } from "../src/agent-budget.js";
import {
  createTurnGuard,
  createWrapUpNudgeQueue,
  type SteeringCapableSession,
  type TurnSessionSurface,
  turnExhaustionError,
  wrapUpNudgeText,
} from "../src/agent-turns.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";

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
  const total = 10;
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

// ---------------------------------------------------------------------------
// CoreAgent.run maxTurns validation: a bad cap is rejected BEFORE any session
// or model resolution — the SCRIPT_VALIDATION_ERROR WorkflowError is thrown at
// the top of run(), so no session is created. Immediacy is observable through
// the injectable loadTierConfig seam and the onModelResolved/onModelFallback
// callbacks: a bogus model spec would exercise both if resolution were reached.
// ---------------------------------------------------------------------------

/**
 * CoreAgent primed for validation-path runs: no coding tools (constructor
 * stays side-effect-free), a counting tier-config loader, and recorders for
 * every model-resolution callback.
 */
function agentForValidationRuns() {
  let tierConfigReads = 0;
  const modelEvents: string[] = [];
  const agent = new CoreAgent({
    tools: [],
    loadTierConfig: () => {
      tierConfigReads++;
      return null;
    },
  });
  return {
    agent,
    tierConfigReads: () => tierConfigReads,
    modelEvents,
    /** Run options carrying the bad cap plus a model spec that MUST never resolve. */
    runOptions: (maxTurns: number) => ({
      maxTurns,
      model: "bogus-provider/bogus-model",
      onModelResolved: (id: string) => modelEvents.push(`resolved:${id}`),
      onModelFallback: (spec: string) => modelEvents.push(`fallback:${spec}`),
    }),
  };
}

test("CoreAgent.run({ maxTurns: 0 }) rejects immediately with SCRIPT_VALIDATION_ERROR", async () => {
  const { agent, runOptions, tierConfigReads, modelEvents } = agentForValidationRuns();

  await assert.rejects(agent.run("hi", runOptions(0)), (err) => {
    assert.ok(err instanceof WorkflowError);
    assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.equal(err.message, "maxTurns must be an integer >= 1");
    assert.equal(err.recoverable, false);
    assert.deepEqual(err.details, { maxTurns: 0 });
    return true;
  });
  // Thrown before any model resolution / fallback and before any tier-config read.
  assert.deepEqual(modelEvents, []);
  assert.equal(tierConfigReads(), 0);
});

test("CoreAgent.run({ maxTurns: 1.5 }) rejects immediately (non-integer)", async () => {
  const { agent, runOptions, tierConfigReads, modelEvents } = agentForValidationRuns();

  await assert.rejects(agent.run("hi", runOptions(1.5)), (err) => {
    assert.ok(err instanceof WorkflowError);
    assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.deepEqual(err.details, { maxTurns: 1.5 });
    return true;
  });
  assert.deepEqual(modelEvents, []);
  assert.equal(tierConfigReads(), 0);
});

test("CoreAgent.run({ maxTurns: -1 }) rejects immediately (below 1)", async () => {
  const { agent, runOptions, tierConfigReads, modelEvents } = agentForValidationRuns();

  await assert.rejects(agent.run("hi", runOptions(-1)), (err) => {
    assert.ok(err instanceof WorkflowError);
    assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.deepEqual(err.details, { maxTurns: -1 });
    return true;
  });
  assert.deepEqual(modelEvents, []);
  assert.equal(tierConfigReads(), 0);
});

// ---------------------------------------------------------------------------
// Post-prompt decision wiring: when ONLY the turn cap trips in a run, the
// error surfaced after session.prompt() returns is TURNS_EXHAUSTED — never
// TOKEN_BUDGET_EXHAUSTED. run() has no fake-session injection seam in this
// package's harness (createAgentSession is a direct module-level import), so
// this mirrors run()'s post-prompt decision order — budget exhaustion checked
// first, then turnGuard.exhaustion → turnExhaustionError — over the real
// guards driven on a shared fake session.
// ---------------------------------------------------------------------------

test("post-prompt decision: turn cap alone trips → TURNS_EXHAUSTED, never TOKEN_BUDGET_EXHAUSTED", () => {
  const total = 10;
  const { session } = fakeCombinedSession(() => ({ tokens: { total }, cost: 0 }));
  const budget = createBudgetGuard(session, { tokenBudget: 1000 });
  const turns = createTurnGuard(session, { maxTurns: 2 });

  const feed = (event: unknown) => {
    budget.onSessionEvent(event);
    turns.onSessionEvent(event);
  };

  // Two full turns well under the budget, then turn 3 starts — only the turn
  // cap fires; the budget guard stays inert.
  runTurn({ onSessionEvent: feed });
  runTurn({ onSessionEvent: feed });
  feed(turnStart());
  assert.equal(budget.exhaustion, undefined);
  assert.deepEqual(turns.exhaustion, { maxTurns: 2, turnsUsed: 2 });

  // run()'s post-prompt precedence, mirrored: the budget check runs first but
  // finds nothing, so the turn-cap check classifies the abort.
  const budgetExhausted = budget.exhaustion;
  if (budgetExhausted) {
    throw new Error("budget must not be exhausted in this run");
  }
  assert.ok(turns.exhaustion);
  const thrown = turnExhaustionError(turns.exhaustion, "impl");
  assert.ok(thrown instanceof WorkflowError);
  assert.equal(thrown.code, WorkflowErrorCode.TURNS_EXHAUSTED);
  assert.notEqual(thrown.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
  assert.deepEqual(thrown.details, { maxTurns: 2, turnsUsed: 2 });
});

// ---------------------------------------------------------------------------
// createWrapUpNudgeQueue (last-turn wrap-up nudge): at the turn_start of the
// second-to-last turn of a capped run, queue the nudge text via the session's
// steering method — exactly once, with the cap interpolated. Never for
// uncapped runs, maxTurns:1, or wrapUpNudge:false; a string overrides the text.
// ---------------------------------------------------------------------------

/** Minimal session double: records steer() calls (mirrors fakeTurnSession). */
function fakeSteerSession() {
  const steered: string[] = [];
  const session: SteeringCapableSession = {
    steer: (text: string) => {
      steered.push(text);
      return Promise.resolve();
    },
  };
  return { session, steered };
}

/**
 * Drive a turn guard + nudge queue the way agent.ts's subscribe seam does:
 * guard first, then the nudge reading the guard's authoritative turnsUsed.
 */
function mkCappedRun(
  steerSession: SteeringCapableSession,
  opts: { maxTurns?: number; wrapUpNudge?: boolean | string },
) {
  const guard = createTurnGuard({ abort: () => {} }, opts);
  const nudge = createWrapUpNudgeQueue(steerSession, opts);
  return {
    feed(event: unknown) {
      guard.onSessionEvent(event);
      nudge.onSessionEvent(event, guard.turnsUsed);
    },
  };
}

test("maxTurns:3 → steer called exactly once at turn_start of turn 2, text names the cap", () => {
  const { session, steered } = fakeSteerSession();
  const run = mkCappedRun(session, { maxTurns: 3 });

  run.feed(turnStart()); // turn 1 (turnsUsed 0 ≠ maxTurns-2) — not yet
  assert.equal(steered.length, 0);
  run.feed(turnEnd());

  run.feed(turnStart()); // turn 2 (turnsUsed 1 === maxTurns-2) → queue the nudge
  assert.equal(steered.length, 1);
  assert.match(steered[0] ?? "", /Wrap-up notice/);
  assert.match(steered[0] ?? "", /turns cap \(3\)/);

  run.feed(turnEnd());
  run.feed(turnStart()); // turn 3 (the final turn) — one-shot, never re-queued
  assert.equal(steered.length, 1);
});

test("maxTurns:2 → queues at the FIRST turn's start (that run's second-to-last turn)", () => {
  const { session, steered } = fakeSteerSession();
  const run = mkCappedRun(session, { maxTurns: 2 });

  run.feed(turnStart()); // turnsUsed 0 === maxTurns-2 → fire immediately
  assert.equal(steered.length, 1);
  assert.match(steered[0] ?? "", /turns cap \(2\)/);
});

test("no maxTurns → nudge never queued (uncapped runs have no last turn)", () => {
  const { session, steered } = fakeSteerSession();
  const run = mkCappedRun(session, {});
  for (let i = 0; i < 4; i++) {
    run.feed(turnStart());
    run.feed(turnEnd());
  }
  assert.equal(steered.length, 0);
});

test("maxTurns:1 → never queued (a one-turn cap has no second-to-last turn to save)", () => {
  const { session, steered } = fakeSteerSession();
  const run = mkCappedRun(session, { maxTurns: 1 });

  run.feed(turnStart());
  run.feed(turnEnd());
  run.feed(turnStart()); // turn 2 — the guard aborts here; the nudge stays silent
  assert.equal(steered.length, 0);
});

test("wrapUpNudge:false → disabled even on a capped run", () => {
  const { session, steered } = fakeSteerSession();
  const run = mkCappedRun(session, { maxTurns: 3, wrapUpNudge: false });

  run.feed(turnStart());
  run.feed(turnEnd());
  run.feed(turnStart()); // would fire without the kill-switch
  assert.equal(steered.length, 0);
});

test("wrapUpNudge:string → the caller's text passes through verbatim", () => {
  const { session, steered } = fakeSteerSession();
  const run = mkCappedRun(session, { maxTurns: 3, wrapUpNudge: "CUSTOM: land the plane now" });

  run.feed(turnStart());
  run.feed(turnEnd());
  run.feed(turnStart());
  assert.deepEqual(steered, ["CUSTOM: land the plane now"]);
});

test("wrapUpNudgeText interpolates the cap into the default nudge", () => {
  assert.equal(
    wrapUpNudgeText(7),
    "[dispatch] Wrap-up notice: your next turn is the last before the turns cap (7). Stop starting new work — finish the current step minimally, then produce your final report (include the commit sha if you committed).",
  );
});
