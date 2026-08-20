/**
 * schema-cost.regression.test.ts — pins the total schema-token cost of
 * obsidian's 2 tools (fat tool + help). Baseline measured 2026-07-13 at
 * commit 2b3f987c. Uses the main default-export factory (lightweight at
 * registration — no vault I/O until a tool executes).
 */
import { test, expect, describe } from "bun:test";
import { captureTools, estimateTotalSchemaTokens, assertWithinBudget } from "../../../../perf-harness/src/index.ts";
import obsidianFactory from "../../obsidian.ts";

describe("obsidian schema-cost regression", () => {
  test("2 tools registered", () => {
    const tools = captureTools(obsidianFactory);
    expect(Object.keys(tools).sort()).toEqual(["obsidian", "obsidian_help"]);
  });

  test("total schema ≤ 280 tokens (baseline 234, +19.7% headroom)", () => {
    const tools = captureTools(obsidianFactory);
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      label: "obsidian schema (2 tools)",
      max: 280,
      baseline: 234,
      measuredAt: "2026-07-13",
      commit: "2b3f987c",
    });
  });

  test("no promptSnippet (stealth invariant)", () => {
    const tools = captureTools(obsidianFactory);
    for (const [name, t] of Object.entries(tools)) {
      expect(t.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
    }
  });
});
