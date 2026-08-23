/**
 * grand-total.regression.test.ts — the headline agent-efficiency metric.
 * Pins the COMBINED schema-token cost of all 10 tools across hermes-memory +
 * obsidian + knowledge-card. The standalone distill extension was folded into
 * knowledge-card's `zk_ingest` (action param) on 2026-07-18; distill's former
 * tool surface is now counted inside zk_ingest, not as a separate tool.
 *
 * hermes-memory uses individual register calls (avoids heavy main factory);
 * obsidian + knowledge-card use their main factories (lightweight registration).
 *
 * 11 → 10 on 2026-08-17: hermes-memory's LeanRAG-shape simplification (#1556)
 * collapsed `memory_search` + `session_search` into one unified `search` tool.
 * That PR updated hermes-memory's own schema-cost test but not this
 * cross-package one, which kept importing the deleted `registerMemorySearchTool`
 * — so this file threw a SyntaxError at import time and the whole suite errored
 * out rather than reporting a number. Fixed by adopting the same registration
 * shape hermes-memory's own perf test now uses.
 */
import { test, expect, describe } from "bun:test";
import { createCapturePi, estimateTotalSchemaTokens, assertWithinBudget } from "../src/index.ts";

// Package specifiers, not `../../../bun-apps/…` relative paths. The relative
// form is what let #1556 break this file unnoticed: it reaches across package
// boundaries while package.json declares no dependency, so the edge is invisible
// to the workspace graph and to change-scoped CI, which therefore never runs
// this suite when hermes-memory changes. These three are now declared workspace
// devDependencies so the edge is real.
// hermes-memory — individual register functions
import { registerSearchTool } from "@repo/s2-agent-ext-hermes-memory/src/tools/search-tool.ts";
import { registerSkillTool } from "@repo/s2-agent-ext-hermes-memory/src/tools/skill-tool.ts";
import { registerMemoryTool } from "@repo/s2-agent-ext-hermes-memory/src/tools/memory-tool.ts";
// obsidian + knowledge-card — main factories
import obsidianFactory from "@repo/s2-agent-ext-obsidian/extensions/obsidian.ts";
import kcardFactory from "@repo/s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";

function captureAll(): Record<string, any> {
  const all: Record<string, any> = {};

  // hermes-memory (individual registers — avoids heavy main factory)
  const h = createCapturePi();
  const fake = {} as never;
  registerMemoryTool(h.pi, fake, null, null);
  // Unified search (#1556): memory_search + session_search collapsed into one
  // `search` tool. Registered once with the default legacy session variant,
  // matching production wiring in hermes-memory's composition/tools.ts.
  registerSearchTool(h.pi, fake, fake, { variant: "legacy" } as never);
  registerSkillTool(h.pi, fake);
  Object.assign(all, h.tools);

  // obsidian (main factory)
  const o = createCapturePi();
  obsidianFactory(o.pi);
  Object.assign(all, o.tools);

  // knowledge-card (main factory — now carries the distill pipeline via zk_ingest actions)
  const k = createCapturePi();
  kcardFactory(k.pi);
  Object.assign(all, k.tools);

  return all;
}

describe("cross-extension grand-total schema-cost", () => {
  test("11 tools registered across 3 extensions", () => {
    const tools = captureAll();
    expect(Object.keys(tools).sort()).toEqual(
      [
        // `search` renamed to `search_memory` 2026-08-20 — docs/agents/extension-naming.md
        "memory", "search_memory", "skill_manage", "skill_manage_help",
        "obsidian", "obsidian_help",
        "zk_ingest", "zk_ask", "zk_card", "zk_fs", "knowledge_query",
      ].sort(),
    );
  });

  test("grand total within budget (baseline re-measured 2026-08-23 — zk_fs FS-browse tool, kcard ticket 05)", () => {
    const tools = captureAll();
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    console.log("\n  === AGENT TOOL SURFACE (11 tools) ===");
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"GRAND TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      // `max` is the gate; `baseline` is documentation of the last conscious
      // measurement. Re-measured 2026-08-23: 4282 → 4645 (kcard zk_fs tool
      // +432 tok — the D32 FS read surface; knowledge_query `type` param
      // +58 tok — D18; plus ticket 06's zk_ingest extract option which had
      // kept the old gate green by ~69 tok of headroom).
      // max = 4645 × 1.10 — fresh measurement, never quiet headroom.
      label: "cross-ext grand total (11 tools)",
      max: 5110,
      baseline: 4645,
      measuredAt: "2026-08-23",
      commit: "main",
    });
  });
});
