/**
 * schema-cost.regression.test.ts — pins the total schema-token cost of
 * knowledge-card's 4 tools. Baseline measured 2026-08-22 on main (post
 * vault-mind retirement, context-lifecycle ticket 02): zk_ask's `blend` param
 * (the semantic-blend modes died with vault-mind) dropped it 2367 → 2019 tok.
 * Prior baselines: 2367 tok 2026-07-18 at ca0e4c58 (distill fold into
 * zk_ingest); 1927 tok at 2b3f987c (2026-07-13).
 * Uses the main default-export factory (needs pi.events for host-fn bus,
 * which createCapturePi provides).
 */
import { test, expect, describe } from "bun:test";
import { captureTools, estimateTotalSchemaTokens, assertWithinBudget } from "@repo/perf-harness";
import kcardFactory from "../../knowledge-card.ts";

describe("knowledge-card schema-cost regression", () => {
  test("4 tools registered", () => {
    const tools = captureTools(kcardFactory);
    expect(Object.keys(tools).sort()).toEqual(
      ["knowledge_query", "zk_ask", "zk_card", "zk_ingest"].sort(),
    );
  });

  test("total schema ≤ 2220 tokens (baseline 2019, +10% headroom)", () => {
    const tools = captureTools(kcardFactory);
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      label: "knowledge-card schema (4 tools)",
      max: 2220,
      baseline: 2019,
      measuredAt: "2026-08-22",
      commit: "main",
    });
  });

  test("no promptSnippet (stealth invariant)", () => {
    const tools = captureTools(kcardFactory);
    for (const [name, t] of Object.entries(tools)) {
      expect(t.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
    }
  });
});
