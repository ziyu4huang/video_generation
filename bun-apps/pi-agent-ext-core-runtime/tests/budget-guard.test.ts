import { describe, expect, test } from "bun:test";
import { BUDGET_WRAP_UP_MESSAGE, type BudgetSessionSurface, createBudgetGuard } from "../src/agent.js";

/**
 * Fake session for the two-stage budget stop. Mirrors only the seams
 * createBudgetGuard touches: getSessionStats / abort / sendUserMessage —
 * same harness spirit as the checkBudgetExhaustion pure tests, but driving
 * the stateful wrap-up wiring (flag, followUp injection, second-crossing abort)
 * through the guard's event-routing seam (onSessionEvent).
 */
function fakeSession(tokensTotal: number, cost: number) {
  const sent: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const calls = {
    abortCount: 0,
    setTokens: (total: number) => {
      tokensTotal = total;
    },
    setCost: (c: number) => {
      cost = c;
    },
  };
  const session: BudgetSessionSurface = {
    getSessionStats: () => ({ tokens: { total: tokensTotal }, cost }),
    abort: () => {
      calls.abortCount++;
    },
    sendUserMessage: async (content, options) => {
      sent.push({ content, options });
    },
  };
  return { session, sent, calls };
}

/** A usage observation: one assistant API response finished, carrying usage. */
const usageObservation = () => ({ type: "message_end", message: { role: "assistant", usage: { total: 1 } } });

describe("createBudgetGuard — tokenBudget two-stage wrap-up", () => {
  test("first crossing via the usage seam → wrap-up injected as followUp, NOT aborted", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    // Turn 1 stays under budget — nothing happens.
    calls.setTokens(500);
    guard.onSessionEvent(usageObservation());
    expect(sent).toHaveLength(0);
    expect(calls.abortCount).toBe(0);

    // Next API response crosses the budget MID-TURN (usage seam) → ONE wrap-up
    // notice queued for the next turn, no abort.
    calls.setTokens(1200);
    guard.onSessionEvent(usageObservation());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe(BUDGET_WRAP_UP_MESSAGE);
    expect(sent[0]?.options?.deliverAs).toBe("followUp");
    expect(guard.wrapUpIssued).toBe(true);
    expect(calls.abortCount).toBe(0);
    expect(guard.exhaustion).toBeUndefined();
  });

  test("first crossing via the turn-boundary backstop also earns the wrap-up (both abort paths gated)", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    // No usage-bearing message_end — only a bare state change (turn boundary).
    calls.setTokens(1200);
    guard.onSessionEvent({ type: "turn_end", message: { role: "assistant" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options?.deliverAs).toBe("followUp");
    expect(guard.wrapUpIssued).toBe(true);
    expect(calls.abortCount).toBe(0);
    expect(guard.exhaustion).toBeUndefined();
  });

  test("second crossing after delivered grace turn → session aborted for real with kind 'tokens'", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    calls.setTokens(1200);
    guard.onSessionEvent(usageObservation());
    expect(guard.wrapUpIssued).toBe(true);
    expect(calls.abortCount).toBe(0);

    // The wrap-up followUp is delivered (user-role message event)...
    guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
    expect(calls.abortCount).toBe(0);

    // ...then the grace (wrap-up) turn ends — turn_end re-arms the abort — and
    // with tokens still over budget the abort fires with the exact
    // BudgetExhaustion payload the run() error path surfaces as status "budget".
    calls.setTokens(1800);
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion).toEqual({ kind: "tokens", limit: 1000, actual: 1800 });
    // No second wrap-up message — the flag is one-shot.
    expect(sent).toHaveLength(1);
  });

  test("real sequence: issuing turn_end does NOT abort/re-arm; abort only after followUp delivery + grace turn_end", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    // First crossing issues the wrap-up on a tool-carrying turn — pi-agent-core
    // drains followUps ONLY at a natural stop, so the ISSUING turn's own
    // turn_end fires while the wrap-up followUp is still queued. That turn_end
    // must neither abort nor re-arm (the old guard re-armed here and killed
    // the run before the grace turn ever ran).
    calls.setTokens(1200);
    guard.onSessionEvent({ type: "tool_execution_start" });
    expect(guard.wrapUpIssued).toBe(true);
    expect(calls.abortCount).toBe(0);

    guard.onSessionEvent({ type: "tool_execution_end" });
    expect(calls.abortCount).toBe(0);

    // Issuing turn ends — grace still in-flight (followUp not delivered yet).
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(0);
    expect(guard.exhaustion).toBeUndefined();
    // A second turn_end before delivery is equally inert (continuation turns).
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(0);

    // Grace turn begins: turn_start, then the queued wrap-up followUp is
    // drained and emitted as a USER-role message pair — the delivery signal.
    guard.onSessionEvent({ type: "turn_start" });
    expect(calls.abortCount).toBe(0);
    guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
    expect(calls.abortCount).toBe(0);
    guard.onSessionEvent({ type: "message_end", message: { role: "user" } });
    expect(calls.abortCount).toBe(0);

    // The grace (final) turn streams its flush-to-disk reply — assistant
    // message events with tokens still (monotonically) over budget must not
    // abort mid-stream (both the usage seam and the turn backstop stay gated).
    calls.setTokens(1500);
    guard.onSessionEvent({ type: "message_start", message: { role: "assistant" } });
    guard.onSessionEvent({ type: "message_update", message: { role: "assistant" } });
    guard.onSessionEvent(usageObservation());
    expect(calls.abortCount).toBe(0);

    // Grace turn ends — re-arm, and with tokens still over budget (monotonic)
    // this very check hard-aborts with the exact BudgetExhaustion payload
    // run() surfaces as status "budget".
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion).toEqual({ kind: "tokens", limit: 1000, actual: 1500 });
    // Exactly one wrap-up message, ever.
    expect(sent).toHaveLength(1);

    // No third turn: further events are inert (guard already exhausted).
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
  });

  test("no-delivery event storm after wrap-up issuance — non-turn_end checks never abort", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    // First crossing issues the wrap-up (grace turn queued).
    calls.setTokens(1200);
    guard.onSessionEvent(usageObservation());
    expect(guard.wrapUpIssued).toBe(true);
    expect(calls.abortCount).toBe(0);

    // The real event storm: the subscribe seam fires on EVERY session event,
    // and cumulative tokens are monotonic, so every subsequent check still
    // sees over-budget stats. None of these are post-delivery turn
    // completions (the grace turn is streaming / running tools) → the grace
    // must NOT be revoked.
    const storm = [
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "agent_start",
      "queue_update",
      "message_start",
    ];
    for (const type of storm) {
      guard.onSessionEvent({ type });
      expect(calls.abortCount).toBe(0);
      expect(guard.exhaustion).toBeUndefined();
    }
    // Stats can even keep creeping up mid-grace — still no abort.
    calls.setTokens(1500);
    guard.onSessionEvent({ type: "tool_execution_end" });
    expect(calls.abortCount).toBe(0);

    // turn_end events BEFORE delivery belong to the issuing/continuation
    // turns — no abort, no re-arm (the grace turn has not run yet).
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(0);
    expect(guard.exhaustion).toBeUndefined();

    // Even a turn_start without the user-role delivery does not re-arm.
    guard.onSessionEvent({ type: "turn_start" });
    expect(calls.abortCount).toBe(0);

    // Delivery: the wrap-up followUp lands as a user-role message pair.
    guard.onSessionEvent({ type: "message_start", message: { role: "user" } });
    guard.onSessionEvent({ type: "message_end", message: { role: "user" } });
    expect(calls.abortCount).toBe(0);

    // The grace turn completes (turn_end AFTER delivery) — abort re-arms and,
    // with tokens still over budget, this very check aborts for real.
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion).toEqual({ kind: "tokens", limit: 1000, actual: 1500 });
    // Exactly one wrap-up message, ever.
    expect(sent).toHaveLength(1);

    // No third turn: further events are inert (guard already exhausted).
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
  });

  test("no budget set → no injection, no abort, never exhausted", () => {
    const { session, sent, calls } = fakeSession(9_999_999, 99);
    const guard = createBudgetGuard(session, {});
    guard.onSessionEvent(usageObservation());
    guard.onSessionEvent({ type: "turn_end" });
    expect(sent).toHaveLength(0);
    expect(calls.abortCount).toBe(0);
    expect(guard.exhaustion).toBeUndefined();
    expect(guard.wrapUpIssued).toBe(false);
  });

  test("spendBudget crossed (no tokenBudget) → immediate hard abort, no wrap-up turn", () => {
    const { session, sent, calls } = fakeSession(500, 0.62);
    const guard = createBudgetGuard(session, { spendBudget: 0.5 });
    guard.onSessionEvent(usageObservation());
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion).toEqual({ kind: "spend", limit: 0.5, actual: 0.62 });
    expect(sent).toHaveLength(0);
    expect(guard.wrapUpIssued).toBe(false);
  });

  test("both budgets cross at once → hard abort wins (money valve), no wrap-up", () => {
    const { session, sent, calls } = fakeSession(1200, 0.62);
    const guard = createBudgetGuard(session, { tokenBudget: 1000, spendBudget: 0.5 });
    guard.onSessionEvent(usageObservation());
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion?.kind).toBe("tokens");
    expect(sent).toHaveLength(0);
    expect(guard.wrapUpIssued).toBe(false);
  });

  test("spend hard-abort fires mid-grace even before followUp delivery", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000, spendBudget: 5 });

    calls.setTokens(1200);
    guard.onSessionEvent({ type: "tool_execution_start" }); // wrap-up issued, grace in-flight
    expect(calls.abortCount).toBe(0);

    // Spend crosses while the wrap-up is still queued (issuing turn's turn_end,
    // not yet delivered) — money valve: immediate hard abort regardless.
    calls.setCost(6);
    guard.onSessionEvent({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion?.kind).toBe("tokens");
    expect(sent).toHaveLength(1);
  });

  test("wrap-up already issued, then spend crosses → hard abort", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000, spendBudget: 5 });

    calls.setTokens(1200);
    guard.onSessionEvent(usageObservation()); // wrap-up issued
    expect(calls.abortCount).toBe(0);

    calls.setCost(6);
    guard.onSessionEvent({ type: "turn_end" }); // spend crossing → abort for real
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion?.kind).toBe("tokens");
    expect(sent).toHaveLength(1);
  });

  test("sendUserMessage rejection → falls back to hard abort so the budget is enforced", async () => {
    const calls = { abortCount: 0 };
    const session: BudgetSessionSurface = {
      getSessionStats: () => ({ tokens: { total: 1200 }, cost: 0 }),
      abort: () => {
        calls.abortCount++;
      },
      sendUserMessage: async () => {
        throw new Error("not streaming");
      },
    };
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });
    guard.onSessionEvent(usageObservation());
    // The wrap-up queue call is async — let the rejection land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion).toEqual({ kind: "tokens", limit: 1000, actual: 1200 });
  });

  test("session without sendUserMessage → no grace possible, immediate hard abort (#1329 semantics)", () => {
    const calls = { abortCount: 0 };
    const session: BudgetSessionSurface = {
      getSessionStats: () => ({ tokens: { total: 1200 }, cost: 0 }),
      abort: () => {
        calls.abortCount++;
      },
    };
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });
    guard.onSessionEvent(usageObservation());
    expect(calls.abortCount).toBe(1);
    expect(guard.exhaustion).toEqual({ kind: "tokens", limit: 1000, actual: 1200 });
    expect(guard.wrapUpIssued).toBe(true);
  });

  test("wrap-up message text — flush-to-disk final-turn contract", () => {
    expect(BUDGET_WRAP_UP_MESSAGE).toContain("FINAL turn");
    expect(BUDGET_WRAP_UP_MESSAGE).toContain("disk");
    expect(BUDGET_WRAP_UP_MESSAGE).toContain("one-line pointer");
  });
});
