/**
 * schema-cost.regression.test.ts — pins the total schema-token cost of
 * knowledge-card's 4 tools. Baseline measured 2026-07-13 at commit 2b3f987c.
 * knowledge-card is the fattest ext (1927 tok, 52% of the agent surface).
 * Uses the main default-export factory (needs pi.events for host-fn bus,
 * which createCapturePi provides).
 */
import { test, expect, describe } from "bun:test";
import { captureTools, estimateTotalSchemaTokens, assertWithinBudget } from "../../../../perf-harness/src/index.ts";
import kcardFactory from "../../pi-knowledge-card.ts";

describe("knowledge-card schema-cost regression", () => {
  test("4 tools registered", () => {
    const tools = captureTools(kcardFactory);
    expect(Object.keys(tools).sort()).toEqual(
      ["knowledge_query", "zk_ask", "zk_card", "zk_ingest"].sort(),
    );
  });

  test("total schema ≤ 2120 tokens (baseline 1927, +10% headroom)", () => {
    const tools = captureTools(kcardFactory);
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      label: "knowledge-card schema (4 tools)",
      max: 2120,
      baseline: 1927,
      measuredAt: "2026-07-13",
      commit: "2b3f987c",
    });
  });

  test("no promptSnippet (stealth invariant)", () => {
    const tools = captureTools(kcardFactory);
    for (const [name, t] of Object.entries(tools)) {
      expect(t.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
    }
  });
});
