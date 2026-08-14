import { describe, expect, test } from "bun:test";
import { BUDGET_WRAP_UP_MESSAGE, type BudgetGuardSession, createBudgetGuard } from "../src/agent.js";

/**
 * Fake session for the two-stage budget stop. Mirrors only the seams
 * createBudgetGuard touches: getSessionStats / abort / sendUserMessage —
 * same harness spirit as the checkBudgetExhaustion pure tests, but driving
 * the stateful wrap-up wiring (flag, followUp injection, second-crossing abort).
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
  const session: BudgetGuardSession = {
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

describe("createBudgetGuard — tokenBudget two-stage wrap-up", () => {
  test("first crossing → wrap-up message injected as followUp, NOT aborted, one more turn runs", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    // Turn 1 ends under budget — nothing happens.
    calls.setTokens(500);
    guard.check();
    expect(sent).toHaveLength(0);
    expect(calls.abortCount).toBe(0);

    // Turn 2 crosses the budget → ONE wrap-up notice queued for the next turn.
    calls.setTokens(1200);
    guard.check();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe(BUDGET_WRAP_UP_MESSAGE);
    expect(sent[0]?.options?.deliverAs).toBe("followUp");
    expect(guard.wrapUpIssued).toBe(true);
    // No abort yet: the wrap-up turn is allowed to run. The very next
    // crossing check (turn-end of the wrap-up turn) aborts for real — covered
    // by the second-crossing test below.
    expect(calls.abortCount).toBe(0);
    expect(guard.exhausted).toBeUndefined();
  });

  test("second crossing → session aborted for real with kind 'tokens'", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    calls.setTokens(1200);
    guard.check();
    expect(guard.wrapUpIssued).toBe(true);
    expect(calls.abortCount).toBe(0);

    // The grace (wrap-up) turn ends — turn_end re-arms the abort — and with
    // tokens still over budget the abort fires with the exact
    // BudgetExhaustion payload the run() error path surfaces as status "budget".
    calls.setTokens(1800);
    guard.check({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
    expect(guard.exhausted).toEqual({ kind: "tokens", limit: 1000, actual: 1800 });
    // No second wrap-up message — the flag is one-shot.
    expect(sent).toHaveLength(1);
  });

  test("event storm after wrap-up issuance — non-turn_end checks never abort; turn_end re-arms so the next check aborts with kind 'tokens'", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });

    // First crossing issues the wrap-up (grace turn queued).
    calls.setTokens(1200);
    guard.check();
    expect(guard.wrapUpIssued).toBe(true);
    expect(calls.abortCount).toBe(0);

    // The real event storm: the subscribe seam fires on EVERY session event,
    // and cumulative tokens are monotonic, so every subsequent check still
    // sees over-budget stats. None of these are turn completions (the grace
    // turn is streaming / running tools) → the grace must NOT be revoked.
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
      guard.check({ type });
      expect(calls.abortCount).toBe(0);
      expect(guard.exhausted).toBeUndefined();
    }
    // Stats can even keep creeping up mid-grace — still no abort.
    calls.setTokens(1500);
    guard.check({ type: "tool_execution_end" });
    expect(calls.abortCount).toBe(0);

    // The grace turn completes (turn_end) — abort re-arms with old
    // semantics, so the next token-exhaustion check aborts for real.
    guard.check({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
    expect(guard.exhausted).toEqual({ kind: "tokens", limit: 1000, actual: 1500 });
    // Exactly one wrap-up message, ever.
    expect(sent).toHaveLength(1);

    // No third turn: further checks are inert (guard already exhausted).
    guard.check({ type: "turn_end" });
    expect(calls.abortCount).toBe(1);
  });

  test("no budget set → no injection, no abort, never exhausted", () => {
    const { session, sent, calls } = fakeSession(9_999_999, 99);
    const guard = createBudgetGuard(session, {});
    guard.check();
    guard.check();
    expect(sent).toHaveLength(0);
    expect(calls.abortCount).toBe(0);
    expect(guard.exhausted).toBeUndefined();
    expect(guard.wrapUpIssued).toBe(false);
  });

  test("spendBudget crossed (no tokenBudget) → immediate hard abort, no wrap-up turn", () => {
    const { session, sent, calls } = fakeSession(500, 0.62);
    const guard = createBudgetGuard(session, { spendBudget: 0.5 });
    guard.check();
    expect(calls.abortCount).toBe(1);
    expect(guard.exhausted).toEqual({ kind: "spend", limit: 0.5, actual: 0.62 });
    expect(sent).toHaveLength(0);
    expect(guard.wrapUpIssued).toBe(false);
  });

  test("both budgets cross at once → hard abort wins (money valve), no wrap-up", () => {
    const { session, sent, calls } = fakeSession(1200, 0.62);
    const guard = createBudgetGuard(session, { tokenBudget: 1000, spendBudget: 0.5 });
    guard.check();
    expect(calls.abortCount).toBe(1);
    expect(guard.exhausted?.kind).toBe("tokens");
    expect(sent).toHaveLength(0);
    expect(guard.wrapUpIssued).toBe(false);
  });

  test("wrap-up already issued, then spend crosses → hard abort", () => {
    const { session, sent, calls } = fakeSession(0, 0);
    const guard = createBudgetGuard(session, { tokenBudget: 1000, spendBudget: 5 });

    calls.setTokens(1200);
    guard.check(); // wrap-up issued
    expect(calls.abortCount).toBe(0);

    calls.setCost(6);
    guard.check(); // second crossing (spend) → abort for real
    expect(calls.abortCount).toBe(1);
    expect(guard.exhausted?.kind).toBe("tokens");
    expect(sent).toHaveLength(1);
  });

  test("sendUserMessage rejection → falls back to hard abort so the budget is enforced", async () => {
    const calls = { abortCount: 0 };
    const session: BudgetGuardSession = {
      getSessionStats: () => ({ tokens: { total: 1200 }, cost: 0 }),
      abort: () => {
        calls.abortCount++;
      },
      sendUserMessage: async () => {
        throw new Error("not streaming");
      },
    };
    const guard = createBudgetGuard(session, { tokenBudget: 1000 });
    guard.check();
    // The wrap-up queue call is async — let the rejection land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.abortCount).toBe(1);
    expect(guard.exhausted).toEqual({ kind: "tokens", limit: 1000, actual: 1200 });
  });

  test("wrap-up message text — flush-to-disk final-turn contract", () => {
    expect(BUDGET_WRAP_UP_MESSAGE).toContain("FINAL turn");
    expect(BUDGET_WRAP_UP_MESSAGE).toContain("disk");
    expect(BUDGET_WRAP_UP_MESSAGE).toContain("one-line pointer");
  });
});
