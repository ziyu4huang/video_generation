import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BUDGET_WRAP_UP_MESSAGE,
  type BudgetSessionSurface,
  billableTokens,
  checkBudgetExhaustion,
  checkBudgetWarning,
  createBudgetGuard,
} from "../src/agent-budget.js";

// ---------------------------------------------------------------------------
// ADR-subagent-0009 — the billable metric is REAL tokens (input+output),
// cache excluded. Every 2026-08-25 ledger recon budget-death carried 73–85%
// cacheRead with real usage at/below the done cohort's p90: the cache-
// inclusive total was the false-kill mechanism, not consumption.
// ---------------------------------------------------------------------------

test("billableTokens: breakdown present → input+output (cache excluded)", () => {
  assert.equal(billableTokens({ tokens: { total: 255_157, input: 46_867, output: 802 } }), 47_669);
});

test("billableTokens: no breakdown → falls back to total (guard never disabled)", () => {
  assert.equal(billableTokens({ tokens: { total: 1000 } }), 1000);
  assert.equal(billableTokens({ tokens: { total: 1000, input: undefined, output: undefined } }), 1000);
});

test("checkBudgetExhaustion: cache-heavy usage under budget on the real metric → no exhaustion", () => {
  // The ledger's smoking gun, verbatim shape: total 255k (82% cacheRead),
  // real 47.7k — vs the 120k recon ceiling this run used to die on.
  const stats = { tokens: { total: 255_157, input: 46_867, output: 802 }, cost: 0 };
  assert.equal(checkBudgetExhaustion(stats, { tokenBudget: 120_000 }), undefined);
});

test("checkBudgetExhaustion: real crossing trips with actual = billable, not total", () => {
  const stats = { tokens: { total: 300_000, input: 45_000, output: 5_000 }, cost: 0 };
  assert.deepEqual(checkBudgetExhaustion(stats, { tokenBudget: 40_000 }), {
    kind: "tokens",
    limit: 40_000,
    actual: 50_000,
  });
});

test("checkBudgetExhaustion: same stats without breakdown keep the total-based semantics (fallback)", () => {
  assert.deepEqual(checkBudgetExhaustion({ tokens: { total: 50_001 }, cost: 0 }, { tokenBudget: 50_000 }), {
    kind: "tokens",
    limit: 50_000,
    actual: 50_001,
  });
});

test("checkBudgetWarning: rides the same real-token metric", () => {
  const stats = { tokens: { total: 250_000, input: 79_000, output: 1_000 }, cost: 0 };
  assert.deepEqual(checkBudgetWarning(stats, { tokenBudget: 100_000 }), {
    kind: "tokens",
    limit: 100_000,
    actual: 80_000,
  });
  // 79.9k real (massive cache) does not trip an 100k budget's 80% line.
  assert.equal(
    checkBudgetWarning({ tokens: { total: 900_000, input: 79_000, output: 900 }, cost: 0 }, { tokenBudget: 100_000 }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Direct semantics of checkBudgetExhaustion (previously covered only indirectly
// via s2-agent-ext-subagent tests).
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
// stats from getSessionStats()) detects the crossing MID-TURN; the turn-boundary
// backstop fires when the usage seam never does. tokenBudget crossings are
// TWO-STAGE: the first crossing injects the wrap-up followUp (no abort); the
// abort lands only after the followUp is delivered (user-role message event)
// and the grace turn's turn_end re-arms the check.
// ---------------------------------------------------------------------------

/**
 * Minimal session double: records aborts + queued wrap-up followUps, serves
 * scripted cumulative stats.
 */
function fakeSession(stats: () => { tokens: { total: number }; cost: number }) {
  const aborts: number[] = [];
  const sent: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const session: BudgetSessionSurface = {
    abort: () => {
      aborts.push(1);
    },
    getSessionStats: stats,
    sendUserMessage: async (content, options) => {
      sent.push({ content, options });
    },
  };
  return { session, aborts, sent };
}

/** A usage observation: one assistant API response finished, carrying usage. */
const usageObservation = (total: number) => ({
  type: "message_end",
  message: { role: "assistant", usage: { total } },
});

/** A bare state change (turn boundary) with no usage on the message. */
const turnBoundary = () => ({ type: "turn_end", message: { role: "assistant" } });

test("usage observation above tokenBudget: first crossing issues the wrap-up followUp (no abort); post-grace turn_end aborts", () => {
  let total = 100; // cumulative usage still below budget
  const { session, aborts, sent } = fakeSession(() => ({ tokens: { total }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 1000 });

  guard.onSessionEvent(turnBoundary());
  guard.onSessionEvent(usageObservation(100));
  assert.equal(aborts.length, 0);
  assert.equal(guard.exhaustion, undefined);

  // Next API response pushes cumulative stats above budget, still mid-turn:
  // TWO-STAGE — the wrap-up notice is queued as a followUp, NO abort yet.
  total = 1500;
  guard.onSessionEvent(usageObservation(1500));
  assert.equal(guard.wrapUpIssued, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.content, BUDGET_WRAP_UP_MESSAGE);
  assert.equal(sent[0]?.options?.deliverAs, "followUp");
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);

  // Grace turn: the followUp is delivered (user-role message event)...
  guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
  // ...and completes (turn_end AFTER delivery) — re-armed, tokens still over
  // budget → the real abort with the BudgetExhausted payload (status "budget").
  guard.onSessionEvent(turnBoundary());
  assert.deepEqual(guard.exhaustion, { kind: "tokens", limit: 1000, actual: 1500 });
  assert.equal(guard.firedVia, "turn"); // the aborting check is the grace turn_end
  assert.equal(aborts.length, 1);
});

test("turn-boundary backstop crossing also earns the wrap-up turn when the usage seam never fires", () => {
  const { session, aborts, sent } = fakeSession(() => ({ tokens: { total: 5000 }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 1000 });

  // No usage-bearing message_end — only bare state changes (turn boundaries):
  // the backstop crossing issues the wrap-up (no abort)...
  guard.onSessionEvent(turnBoundary());
  assert.equal(guard.wrapUpIssued, true);
  assert.equal(sent.length, 1);
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);

  // ...delivery + grace turn_end re-arm the check → abort fired via "turn".
  guard.onSessionEvent({ type: "message_end", message: { role: "user" } });
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

  // Drive the full two-stage stop through the usage seam.
  guard.onSessionEvent(usageObservation(9999)); // wrap-up issued, no abort
  guard.onSessionEvent({ type: "message_start", message: { role: "user" } }); // delivered
  guard.onSessionEvent(turnBoundary()); // grace turn ended → abort
  const first = guard.exhaustion;
  assert.ok(first);
  assert.equal(guard.firedVia, "turn"); // the aborting check is the grace turn_end

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
  const { session, aborts, sent } = fakeSession(() => {
    if (total === undefined) throw new Error("no entries yet");
    return { tokens: { total }, cost: 0 };
  });
  const guard = createBudgetGuard(session, { tokenBudget: 1000 });

  guard.onSessionEvent(usageObservation(0)); // stats not ready — swallowed
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);

  total = 2000;
  guard.onSessionEvent(usageObservation(2000));
  // First crossing → wrap-up followUp queued, abort deferred to post-grace.
  assert.equal(guard.wrapUpIssued, true);
  assert.equal(sent.length, 1);
  assert.equal(aborts.length, 0);
  assert.equal(guard.exhaustion, undefined);

  guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
  guard.onSessionEvent(turnBoundary());
  assert.deepEqual(guard.exhaustion, { kind: "tokens", limit: 1000, actual: 2000 });
  assert.equal(aborts.length, 1);
});

// ---------------------------------------------------------------------------
// ADR-subagent-0009 wiring: a breakdown-carrying session surface (the real
// SDK shape) is billed on REAL tokens — cache-heavy big-context children no
// longer die on cacheRead re-billing; the grace ceiling also compares real.
// ---------------------------------------------------------------------------

test("guard: cache-heavy surface never crosses on cacheRead; real crossing earns the wrap-up", () => {
  // input/output grow slowly; cacheRead re-bills the whole context each round.
  const stats = { input: 30_000, output: 2_000, cacheRead: 180_000, total: 212_000 };
  const { session, aborts, sent } = fakeSession(() => ({ tokens: { ...stats }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 120_000 }); // the recon ceiling

  // 212k cache-inclusive total, 32k real — the exact shape that died as a
  // "budget" status before ADR-subagent-0009. No wrap-up, no abort.
  guard.onSessionEvent(usageObservation(stats.total));
  guard.onSessionEvent(turnBoundary());
  assert.equal(guard.wrapUpIssued, false);
  assert.equal(guard.exhaustion, undefined);
  assert.equal(aborts.length, 0);

  // Real work eventually crosses: wrap-up queued (actual = billable 131k).
  stats.input = 125_000;
  stats.total = 307_000;
  guard.onSessionEvent(usageObservation(stats.total));
  assert.equal(guard.wrapUpIssued, true);
  assert.equal(sent.length, 1);
  assert.equal(guard.exhaustion, undefined);

  guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
  guard.onSessionEvent(turnBoundary());
  assert.deepEqual(guard.exhaustion, { kind: "tokens", limit: 120_000, actual: 127_000 });
  assert.equal(aborts.length, 1);
});

test("guard: grace ceiling compares REAL tokens — mid-grace cache re-billing alone never aborts", () => {
  // budget 100k → grace ceiling 1.25x = 125k REAL.
  const stats = { input: 105_000, output: 5_000, cacheRead: 300_000, total: 410_000 };
  const { session, aborts } = fakeSession(() => ({ tokens: { ...stats }, cost: 0 }));
  const guard = createBudgetGuard(session, { tokenBudget: 100_000 });

  // First real crossing (110k real) → wrap-up queued, grace in flight.
  guard.onSessionEvent(usageObservation(stats.total));
  assert.equal(guard.wrapUpIssued, true);
  assert.equal(aborts.length, 0);

  // Mid-grace: cache re-billing explodes the INCLUSIVE total to 9.1x the
  // budget — far past the 1.25x grace ceiling — while real stays 110k < 125k.
  // The ceiling compares REAL: no abort.
  stats.cacheRead = 800_000;
  stats.total = 910_000;
  guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
  guard.onSessionEvent(usageObservation(stats.total));
  assert.equal(aborts.length, 0);
  assert.equal(guard.exhaustion, undefined);

  // Real grows past the ceiling mid-grace (input 120k + output 6k = 126k
  // > 125k) → immediate hard abort even with the wrap-up still in flight.
  stats.input = 120_000;
  stats.output = 6_000;
  stats.total = 926_000;
  guard.onSessionEvent(usageObservation(stats.total));
  assert.deepEqual(guard.exhaustion, { kind: "tokens", limit: 100_000, actual: 126_000 });
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
