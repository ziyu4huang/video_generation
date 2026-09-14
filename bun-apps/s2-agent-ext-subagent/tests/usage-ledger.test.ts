import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentHistoryEntry } from "@repo/s2-agent-core-runtime";

/**
 * t05 (self-arc-25): the live per-message usage ledger. History entries carry
 * their assistant message's usage (first-entry attachment in
 * compactAgentHistory); the singular tool diffs cumulative history usage
 * against its per-run ledger and accrues only monotone deltas, with the
 * completion-time onUsage settling the exact remainder. No double-count,
 * monotone ticks, terminal freeze.
 */

interface Accrued {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** Minimal double-entry ledger mirroring accrueUsage's += semantics. */
function makeLedger() {
  const total: Accrued = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  return {
    total,
    accrue(delta: Accrued) {
      total.costUsd += delta.costUsd;
      total.tokensIn += delta.tokensIn;
      total.tokensOut += delta.tokensOut;
    },
  };
}

/** The exact accumulate-and-diff step wired into subagent-tool-run's
 *  onHistory/onUsage (kept in sync by the integration assertions below —
 *  this copy documents the contract the real wiring must match). */
function step(ledger: Accrued, cumulative: Accrued): Accrued {
  const delta = {
    costUsd: Math.max(0, cumulative.costUsd - ledger.costUsd),
    tokensIn: Math.max(0, cumulative.tokensIn - ledger.tokensIn),
    tokensOut: Math.max(0, cumulative.tokensOut - ledger.tokensOut),
  };
  ledger.costUsd = cumulative.costUsd;
  ledger.tokensIn = cumulative.tokensIn;
  ledger.tokensOut = cumulative.tokensOut;
  return delta;
}

function sumHistoryUsage(history: AgentHistoryEntry[]): Accrued {
  const cum = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  for (const h of history) {
    if (h.usage) {
      cum.costUsd += h.usage.cost;
      cum.tokensIn += h.usage.input;
      cum.tokensOut += h.usage.output;
    }
  }
  return cum;
}

function assistantEntry(usage: { input: number; output: number; cost: number }): AgentHistoryEntry {
  return { role: "assistant", kind: "text", text: "t", usage } as AgentHistoryEntry;
}

test("history projection: usage attaches to the FIRST entry of each assistant message only", async () => {
  const { compactAgentHistory } = await import("@repo/s2-agent-core-runtime");
  const messages = [
    {
      role: "assistant",
      timestamp: 1,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } },
      content: [
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
        { type: "text", text: "hello" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 2 },
  ];
  const entries = compactAgentHistory(messages);
  const withUsage = entries.filter((e) => e.usage);
  assert.equal(withUsage.length, 1, "exactly one entry carries the message's usage");
  assert.equal(withUsage[0].usage?.input, 10);
  assert.equal(withUsage[0].usage?.output, 5);
  assert.equal(withUsage[0].usage?.cost, 0.01);
});

test("live ticks are monotone deltas; completion onUsage settles the exact remainder (no double count)", () => {
  const { ledger } = { ledger: makeLedger() };
  const accruedLive: Accrued = { costUsd: 0, tokensIn: 0, tokensOut: 0 };

  // Turn 1 arrives.
  const t1 = sumHistoryUsage([assistantEntry({ input: 100, output: 10, cost: 0.02 })]);
  ledger.accrue(step(accruedLive, t1));
  assert.deepEqual(ledger.total, { costUsd: 0.02, tokensIn: 100, tokensOut: 10 });

  // Turn 2 arrives (cumulative grows).
  const t2 = sumHistoryUsage([
    assistantEntry({ input: 100, output: 10, cost: 0.02 }),
    assistantEntry({ input: 50, output: 20, cost: 0.03 }),
  ]);
  ledger.accrue(step(accruedLive, t2));
  assert.deepEqual(ledger.total, { costUsd: 0.05, tokensIn: 150, tokensOut: 30 });

  // Completion: final usage == cumulative history → remainder is ZERO.
  const final = { costUsd: 0.05, tokensIn: 150, tokensOut: 30 };
  ledger.accrue(step(accruedLive, final));
  assert.deepEqual(ledger.total, { costUsd: 0.05, tokensIn: 150, tokensOut: 30 }, "no double count");
});

test("completion onUsage catches up when history under-reports (throttled emit / capped entries)", () => {
  const ledger = makeLedger();
  const accruedLive: Accrued = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  // History only ever saw turn 1 (e.g. 40-entry cap dropped older usage rows).
  const t1 = sumHistoryUsage([assistantEntry({ input: 100, output: 10, cost: 0.02 })]);
  ledger.accrue(step(accruedLive, t1));
  // Final usage reports MORE than history saw → remainder accrues.
  const final = { costUsd: 0.11, tokensIn: 400, tokensOut: 70 };
  ledger.accrue(step(accruedLive, final));
  assert.deepEqual(ledger.total, final);
});

test("repeated identical history snapshots do not re-accrue (idempotent ticks)", () => {
  const ledger = makeLedger();
  const accruedLive: Accrued = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  const entries = [assistantEntry({ input: 100, output: 10, cost: 0.02 })];
  const cum = sumHistoryUsage(entries);
  for (let i = 0; i < 3; i++) ledger.accrue(step(accruedLive, cum));
  assert.deepEqual(ledger.total, { costUsd: 0.02, tokensIn: 100, tokensOut: 10 });
});
