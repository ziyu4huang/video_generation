/**
 * schema-cost.regression.test.ts — pins the total schema-token cost of
 * hermes-memory's 4 tools. Baseline measured 2026-07-13 at commit 2b3f987c.
 *
 * Uses individual registerXxxTool calls (NOT the heavy main factory) — matches
 * the stealth-trim.test.ts pattern. The register functions produce the same
 * tool schemas the LLM sees; the unified search tool is registered once with
 * its default (legacy) session variant, matching production.
 */
import { test, expect, describe } from "bun:test";
import { createCapturePi, estimateTotalSchemaTokens, assertWithinBudget } from "../../../perf-harness/src/index.ts";
import { registerSearchTool } from "../../src/tools/search-tool.ts";
import { registerSkillTool } from "../../src/tools/skill-tool.ts";
import { registerMemoryTool } from "../../src/tools/memory-tool.ts";

function captureHermesTools(): Record<string, any> {
  const { pi, tools } = createCapturePi();
  const fake = {} as never;
  registerMemoryTool(pi, fake, null);
  registerSearchTool(pi, fake, fake, { variant: "legacy" } as never);
  registerSkillTool(pi, fake);
  return tools;
}

describe("hermes-memory schema-cost regression", () => {
  test("4 tools registered", () => {
    const tools = captureHermesTools();
    expect(Object.keys(tools).sort()).toEqual(
      ["memory", "search", "skill_manage", "skill_manage_help"].sort(),
    );
  });

  test("total schema ≤ 1700 tokens (baseline 1550, +9.7% headroom)", () => {
    const tools = captureHermesTools();
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    // Log per-tool for visibility on failure
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      label: "hermes-memory schema (4 tools)",
      max: 1700,
      baseline: 1550,
      measuredAt: "2026-07-13",
      commit: "2b3f987c",
    });
  });

  test("no tool has promptSnippet or promptGuidelines (stealth invariant)", () => {
    const tools = captureHermesTools();
    for (const [name, t] of Object.entries(tools)) {
      expect(t.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
      expect(t.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
    }
  });
});
