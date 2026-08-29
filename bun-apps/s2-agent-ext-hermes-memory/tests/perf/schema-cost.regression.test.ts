/**
 * schema-cost.regression.test.ts — pins the total schema-token cost of
 * hermes-memory's 6 tools (ticket 10 hard pin).
 *
 * Uses individual registerXxxTool calls (NOT the heavy main factory) — matches
 * the stealth-trim.test.ts pattern. The register functions produce the same
 * tool schemas the LLM sees; the unified search tool is registered once with
 * its default (legacy) session variant, matching production.
 */
import { test, expect, describe } from "bun:test";
import { createCapturePi, estimateTotalSchemaTokens, assertWithinBudget } from "@repo/perf-harness";
import { registerSearchTool } from "../../src/tools/search-tool.ts";
import { registerSkillTool } from "../../src/tools/skill-tool.ts";
import { registerMemoryTool } from "../../src/tools/memory-tool.ts";
import { registerKnowledgeIngestTool } from "../../src/tools/knowledge-ingest-tool.ts";
import { registerKnowledgeSearchTool } from "../../src/tools/knowledge-search-tool.ts";

// Ticket 10 final pin — measured at 4ddd1a21 (6-tool surface, post-trim):
const SIX_TOOL_BASELINE = 2033; // measured 2033 tok after knowledge-tool trims
const SIX_TOOL_MEASURED_AT = "2026-08-17";
const SIX_TOOL_MEASURED_COMMIT = "4ddd1a21";
export const BUDGET_MAX_TOKENS = 2100; // measured 2033 + headroom to the 2100 ceiling

function captureHermesTools(): Record<string, any> {
  const { pi, tools } = createCapturePi();
  const fake = {} as never;
  registerMemoryTool(pi, fake, null);
  registerSearchTool(pi, fake, fake, { variant: "legacy" } as never);
  registerSkillTool(pi, fake);
  registerKnowledgeIngestTool(pi);
  registerKnowledgeSearchTool(pi, () => "/tmp");
  return tools;
}

describe("hermes-memory schema-cost regression", () => {
  test("6 tools registered", () => {
    const tools = captureHermesTools();
    expect(Object.keys(tools).sort()).toEqual(
      // `search` renamed to `search_memory` 2026-08-20 (see bun-apps/s2-agent-ext-devops/skills/extension-naming/SKILL.md)
      ["memory", "search_memory", "knowledge_ingest", "knowledge_search", "skill_manage", "skill_manage_help"].sort(),
    );
  });

  test("total schema ≤ 2100 tokens (ticket 10 hard pin; measured 2033)", () => {
    const tools = captureHermesTools();
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    // Log per-tool for visibility on failure
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      label: "hermes-memory schema (6 tools)",
      max: BUDGET_MAX_TOKENS, // ticket 10 final 6-tool hard pin (spec decision 6); re-pin consciously, never silently
      baseline: SIX_TOOL_BASELINE,
      measuredAt: SIX_TOOL_MEASURED_AT,
      commit: SIX_TOOL_MEASURED_COMMIT,
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
