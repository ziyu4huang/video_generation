/**
 * The `SpawnSubagentResult.failure` union — the outcome contract.
 *
 * This file replaces an invariant that used to live in TWO places and was kept
 * aligned by hand: `classifyError`'s branch order in spawn-subagent.ts, and
 * `deriveSubagentStatus`'s precedence chain in subagent-tool-render.ts (budget >
 * turns > timedout > failed). With the union, `failure.kind` IS the status, so
 * the classification order is load-bearing in exactly one place — and that makes
 * it worth pinning exhaustively here, one case per branch of `classifyError`.
 *
 * The subtle cases are the two "detail-less" ones. A WorkflowError may carry no
 * `details`, and both before and after this change the PRESENCE of the detail
 * object is what selects the kind: a TURNS_EXHAUSTED with no details is a plain
 * `failed`, not a `turns`. Losing that would silently re-label runs in the
 * viewer and in every persisted record.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { type AgentUsage, spawnSubagent, WorkflowError, WorkflowErrorCode } from "@repo/s2-agent-core-runtime";

/** Runner that always throws `e`. Retry is disabled per-call so each test
 *  observes exactly one classification rather than a retried pair. */
function throwingRunner(e: unknown) {
  return { run: async () => Promise.reject(e) };
}

async function failureOf(e: unknown) {
  const out = await spawnSubagent({ task: "t", agent: throwingRunner(e), retryOnTransient: false });
  return out.failure;
}

describe("SpawnSubagentResult.failure", () => {
  it("is absent on success, and the result carries no outcome fields beyond output/usage", async () => {
    const out = await spawnSubagent({ task: "t", agent: { run: async () => "RESULT" } });
    assert.equal(out.failure, undefined);
    assert.equal(out.output, "RESULT");
    // The removed subprocess vocabulary must not linger as vestigial fields.
    assert.ok(!("exitCode" in out), "exitCode must be gone from the result");
    assert.ok(!("stderr" in out), "stderr must be gone from the result");
    assert.ok(!("timedOut" in out), "timedOut must be gone from the result");
  });

  it("AGENT_TIMEOUT → kind 'timedout'", async () => {
    const f = await failureOf(new WorkflowError("slow", WorkflowErrorCode.AGENT_TIMEOUT));
    assert.equal(f?.kind, "timedout");
    assert.equal(f?.message, "slow");
  });

  it("our own timeoutMs abort → kind 'timedout'", async () => {
    const out = await spawnSubagent({
      task: "t",
      timeoutMs: 1,
      retryOnTransient: false,
      agent: {
        run: async () => new Promise((_r, rej) => setTimeout(() => rej(new Error("Subagent was aborted")), 30)),
      },
    });
    assert.equal(out.failure?.kind, "timedout");
  });

  it("TURNS_EXHAUSTED WITH details → kind 'turns', detail preserved", async () => {
    const detail = { maxTurns: 4, turnsUsed: 4 };
    const f = await failureOf(
      new WorkflowError("max turns exceeded (4)", WorkflowErrorCode.TURNS_EXHAUSTED, { details: detail }),
    );
    assert.equal(f?.kind, "turns");
    assert.deepEqual(f?.kind === "turns" ? f.turns : undefined, detail);
  });

  it("TURNS_EXHAUSTED WITHOUT details → kind 'failed' (presence of the detail selects the kind)", async () => {
    const f = await failureOf(new WorkflowError("max turns exceeded", WorkflowErrorCode.TURNS_EXHAUSTED));
    assert.equal(f?.kind, "failed");
  });

  it("TOKEN_BUDGET_EXHAUSTED WITH details → kind 'budget', detail preserved", async () => {
    const detail = { kind: "tokens" as const, limit: 100, actual: 140 };
    const f = await failureOf(new WorkflowError("over", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, { details: detail }));
    assert.equal(f?.kind, "budget");
    assert.deepEqual(f?.kind === "budget" ? f.budget : undefined, detail);
  });

  it("TOKEN_BUDGET_EXHAUSTED WITHOUT details → kind 'failed'", async () => {
    const f = await failureOf(new WorkflowError("over", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED));
    assert.equal(f?.kind, "failed");
  });

  it("SCHEMA_NONCOMPLIANCE → kind 'failed' (transient, but not timeout-shaped)", async () => {
    const f = await failureOf(new WorkflowError("no structured_output", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE));
    assert.equal(f?.kind, "failed");
  });

  it("a transient network error → kind 'failed'", async () => {
    const f = await failureOf(new Error("fetch failed: ECONNRESET"));
    assert.equal(f?.kind, "failed");
  });

  it("a plain error → kind 'failed', message carried verbatim", async () => {
    const f = await failureOf(new Error("boom"));
    assert.equal(f?.kind, "failed");
    assert.equal(f?.message, "boom");
  });

  it("every variant carries a message, so a caller never has to switch on kind to report", async () => {
    const cases: unknown[] = [
      new WorkflowError("a", WorkflowErrorCode.AGENT_TIMEOUT),
      new WorkflowError("b", WorkflowErrorCode.TURNS_EXHAUSTED, { details: { maxTurns: 1, turnsUsed: 1 } }),
      new WorkflowError("c", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        details: { kind: "tokens", limit: 1, actual: 2 },
      }),
      new Error("d"),
    ];
    for (const e of cases) {
      const f = await failureOf(e);
      assert.equal(typeof f?.message, "string");
      assert.ok((f?.message.length ?? 0) > 0, `empty message for ${String(e)}`);
    }
  });

  it("a completed run at ≥80% of budget reports budgetWarning and NO failure", async () => {
    const usage: AgentUsage = { input: 85, output: 0, cacheRead: 0, cacheWrite: 0, total: 85, cost: 0 };
    const out = await spawnSubagent({
      task: "t",
      tokenBudget: 100,
      agent: {
        run: async (_p: string, o: Record<string, unknown>) => {
          (o.onUsage as (u: AgentUsage) => void)?.(usage);
          return "done";
        },
      } as never,
    });
    assert.equal(out.failure, undefined, "an advisory warning must never read as a failure");
    assert.equal(out.budgetWarning?.kind, "tokens");
  });

  it("the retry gate keys off `failure`, not a numeric code: one transient failure then success", async () => {
    let n = 0;
    const out = await spawnSubagent({
      task: "t",
      agent: {
        run: async () => {
          n += 1;
          if (n === 1) throw new WorkflowError("flaky", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
          return "second-ok";
        },
      },
    });
    assert.equal(n, 2);
    assert.equal(out.failure, undefined);
    assert.equal(out.output, "second-ok");
  });
});
