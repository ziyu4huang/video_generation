/**
 * grand-total.regression.test.ts — the headline agent-efficiency metric.
 * Pins the COMBINED schema-token cost of all 11 tools across hermes-memory +
 * obsidian + knowledge-card. The standalone distill extension was folded into
 * knowledge-card's `zk_ingest` (action param) on 2026-07-18; distill's former
 * tool surface is now counted inside zk_ingest, not as a separate tool.
 *
 * hermes-memory uses individual register calls (avoids heavy main factory);
 * obsidian + knowledge-card use their main factories (lightweight registration).
 */
import { test, expect, describe } from "bun:test";
import { createCapturePi, estimateTotalSchemaTokens, assertWithinBudget } from "../src/index.ts";

// hermes-memory — individual register functions
import { registerMemorySearchTool } from "../../../bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-search-tool.ts";
import { registerSessionSearchTool } from "../../../bun-apps/pi-agent-ext-hermes-memory/src/tools/session-search-tool.ts";
import { registerSkillTool } from "../../../bun-apps/pi-agent-ext-hermes-memory/src/tools/skill-tool.ts";
import { registerMemoryTool } from "../../../bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts";
// obsidian + knowledge-card — main factories
import obsidianFactory from "../../../bun-apps/pi-agent-ext-obsidian/extensions/obsidian.ts";
import kcardFactory from "../../../bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts";

function captureAll(): Record<string, any> {
  const all: Record<string, any> = {};

  // hermes-memory (individual registers — avoids heavy main factory)
  const h = createCapturePi();
  const fake = {} as never;
  registerMemoryTool(h.pi, fake, null, null);
  registerMemorySearchTool(h.pi, fake);
  registerSessionSearchTool(h.pi, fake, { variant: "legacy" } as never);
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
    expect(Object.keys(tools).length).toBe(11);
  });

  test("grand total within budget (baseline re-measured 2026-07-18 after distill fold)", () => {
    const tools = captureAll();
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    console.log("\n  === AGENT TOOL SURFACE (11 tools) ===");
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"GRAND TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      label: "cross-ext grand total (11 tools)",
      max: 4576,
      baseline: 4160,
      measuredAt: "2026-07-18",
      commit: "merge-distill-into-knowledge-card",
    });
  });
});
