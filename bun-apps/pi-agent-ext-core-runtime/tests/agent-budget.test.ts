import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type BudgetSessionSurface,
  checkBudgetExhaustion,
  checkBudgetWarning,
  createBudgetGuard,
} from "../src/agent.js";

// ---------------------------------------------------------------------------
// Direct semantics of checkBudgetExhaustion (previously covered only indirectly
// via pi-agent-ext-subagent tests).
// ---------------------------------------------------------------------------

test("checkBudgetExhaustion: total == limit is allowed (strict >)", () => {
  assert.equal(checkBudgetExhaustion({ tokens: { total: 1000 }, cost: 0 }, { tokenBudget: 1000 }), undefined);
  assert.equal(checkBudgetExhaustion({ tokens: { total: 10 }, cost: 0.5 }, { spendBudget: 0.5 }), undefined);
});

test("checkBudgetExhaustion: total > tokenBudget → tokens exhaustion", () => {
  assert.deepEqual(checkBudgetExhaustion({ tokens: { total: 1001 }, cost: 0 }, { tokenBudget: 1000 }), {
    kind: "tokens",
    limit: 1000,
    actual: 1001,
  });
});

test("checkBudgetExhaustion: cost > spendBudget → spend exhaustion", () => {
  assert.deepEqual(
    checkBudgetExhaustion({ tokens: { total: 10 }, cost: 0.51 }, { tokenBudget: 100, spendBudget: 0.5 }),
    {
      kind: "spend",
      limit: 0.5,
      actual: 0.51,
    },
  );
});

test("checkBudgetExhaustion: tokens checked before spend when both exceeded", () => {
  const result = checkBudgetExhaustion({ tokens: { total: 200 }, cost: 9 }, { tokenBudget: 100, spendBudget: 0.5 });
  assert.equal(result?.kind, "tokens");
});

test("checkBudgetExhaustion: no budgets set → undefined regardless of usage", () => {
  assert.equal(checkBudgetExhaustion({ tokens: { total: 1_000_000 }, cost: 999 }, {}), undefined);
});

// ---------------------------------------------------------------------------
// Wiring: createBudgetGuard over a minimal fake session — the usage-observation
// seam (assistant message_end carrying usage = one API response, cumulative
// stats from getSessionStats()) aborts MID-TURN; the turn-boundary backstop
// fires when the usage seam never does.
// ---------------------------------------------------------------------------

/** Minimal session double: records aborts, serves scripted cumulative stats. */
function fakeSession(stats: () => { tokens: { total: number }; cost: number }) {
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

/** A bare state change (turn boundary) with no usage on the message. */
const turnBoundary = () => ({ type: "turn_end", message: { role: "assistant" } });

test("usage observation above tokenBudget aborts mid-turn (no turn boundary needed)", () => {
  let total = 100; // cumulative usage still below budget
  const { session, aborts } = fakeSession(() => ({ tokens: { total }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 1000 });

  guard.onSessionEvent(turnBoundary());
  guard.onSessionEvent(usageObservation(100));
  assert.equal(aborts.length, 0);
  assert.equal(guard.exhaustion, undefined);

  // Next API response pushes cumulative stats above budget, still mid-turn.
  total = 1500;
  guard.onSessionEvent(usageObservation(1500));
  assert.deepEqual(guard.exhaustion, { kind: "tokens", limit: 1000, actual: 1500 });
  assert.equal(guard.firedVia, "usage");
  assert.equal(aborts.length, 1);
});

test("turn-boundary backstop still aborts when the usage seam never fires", () => {
  const { session, aborts } = fakeSession(() => ({ tokens: { total: 5000 }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 1000 });

  // No usage-bearing message_end — only bare state changes (turn boundaries).
  guard.onSessionEvent(turnBoundary());
  assert.deepEqual(guard.exhaustion, { kind: "tokens", limit: 1000, actual: 5000 });
  assert.equal(guard.firedVia, "turn");
  assert.equal(aborts.length, 1);
});

test("spend budget aborts via the usage seam too", () => {
  const { session, aborts } = fakeSession(() => ({ tokens: { total: 10 }, cost: 0.75 }));
  const guard = createBudgetGuard(session, { spendBudget: 0.5 });

  guard.onSessionEvent(usageObservation(10));
  assert.deepEqual(guard.exhaustion, { kind: "spend", limit: 0.5, actual: 0.75 });
  assert.equal(guard.firedVia, "usage");
  assert.equal(aborts.length, 1);
});

test("idempotent: first seam wins; later events never double-abort", () => {
  const { session, aborts } = fakeSession(() => ({ tokens: { total: 9999 }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 100 });

  guard.onSessionEvent(usageObservation(9999));
  const first = guard.exhaustion;
  assert.ok(first);

  guard.onSessionEvent(turnBoundary());
  guard.onSessionEvent(usageObservation(9999));
  assert.equal(guard.exhaustion, first); // record unchanged — first seam wins
  assert.equal(aborts.length, 1); // exactly one abort
});

test("usage exactly at the limit never aborts", () => {
  const { session, aborts } = fakeSession(() => ({ tokens: { total: 1000 }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 1000 });

  guard.onSessionEvent(usageObservation(1000));
  guard.onSessionEvent(turnBoundary());
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);
});

test("no budgets configured → never aborts", () => {
  const { session, aborts } = fakeSession(() => ({ tokens: { total: 1_000_000 }, cost: 999 }));
  const guard = createBudgetGuard(session, {});

  guard.onSessionEvent(usageObservation(1_000_000));
  guard.onSessionEvent(turnBoundary());
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);
});

test("stats not yet available (getSessionStats throws) is skipped, not fatal", () => {
  let total: number | undefined;
  const { session, aborts } = fakeSession(() => {
    if (total === undefined) throw new Error("no entries yet");
    return { tokens: { total }, cost: 0 };
  });
  const guard = createBudgetGuard(session, { tokenBudget: 1000 });

  guard.onSessionEvent(usageObservation(0)); // stats not ready — swallowed
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);

  total = 2000;
  guard.onSessionEvent(usageObservation(2000));
  assert.deepEqual(guard.exhaustion, { kind: "tokens", limit: 1000, actual: 2000 });
  assert.equal(aborts.length, 1);
});

// ---------------------------------------------------------------------------
// Direct semantics of checkBudgetWarning — the informational 80% line (fixed
// BUDGET_WARNING_RATIO = 0.8, no config knob; never aborts, mirrors the
// exhaustion precedence: tokens checked before spend).
// ---------------------------------------------------------------------------

test("checkBudgetWarning: exactly 80% trips (>= at the ratio)", () => {
  assert.deepEqual(checkBudgetWarning({ tokens: { total: 800 }, cost: 0 }, { tokenBudget: 1000 }), {
    kind: "tokens",
    limit: 1000,
    actual: 800,
  });
  assert.deepEqual(checkBudgetWarning({ tokens: { total: 1 }, cost: 0.4 }, { spendBudget: 0.5 }), {
    kind: "spend",
    limit: 0.5,
    actual: 0.4,
  });
});

test("checkBudgetWarning: 79.99% does not trip", () => {
  assert.equal(checkBudgetWarning({ tokens: { total: 799.9 }, cost: 0 }, { tokenBudget: 1000 }), undefined);
  assert.equal(checkBudgetWarning({ tokens: { total: 1 }, cost: 0.399 }, { spendBudget: 0.5 }), undefined);
});

test("checkBudgetWarning: tokens checked before spend when both trip", () => {
  const result = checkBudgetWarning({ tokens: { total: 800 }, cost: 9 }, { tokenBudget: 1000, spendBudget: 0.5 });
  assert.equal(result?.kind, "tokens");
});

test("checkBudgetWarning: no budgets set → undefined regardless of usage", () => {
  assert.equal(checkBudgetWarning({ tokens: { total: 1_000_000 }, cost: 999 }, {}), undefined);
});

test("checkBudgetWarning: below the ratio on the set budget → undefined (other budget unset)", () => {
  assert.equal(checkBudgetWarning({ tokens: { total: 100 }, cost: 0 }, { tokenBudget: 1000 }), undefined);
});
