/**
 * grand-total.regression.test.ts — the headline agent-efficiency metric.
 * Pins the COMBINED schema-token cost of all 12 tools across hermes-memory +
 * obsidian + knowledge-card + distill. Baseline 4148 tok (2026-07-14, feat/wire-distill)
 * — distill params now counted (inputSchema→parameters fix raised the real cost).
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
import kcardFactory from "../../../bun-apps/pi-agent-ext-knowledge-card/extensions/pi-knowledge-card.ts";
// distill — main factory
import distillFactory from "../../../bun-apps/pi-agent-ext-distill/extensions/pi-distill.ts";

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

  // knowledge-card (main factory)
  const k = createCapturePi();
  kcardFactory(k.pi);
  Object.assign(all, k.tools);

  // distill (main factory)
  const d = createCapturePi();
  distillFactory(d.pi);
  Object.assign(all, d.tools);

  return all;
}

describe("cross-extension grand-total schema-cost", () => {
  test("12 tools registered across 4 extensions", () => {
    const tools = captureAll();
    expect(Object.keys(tools).length).toBe(12);
  });

  test("grand total ≤ 4400 tokens (baseline 4148, +6.1% headroom)", () => {
    const tools = captureAll();
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    console.log("\n  === AGENT TOOL SURFACE (12 tools) ===");
    for (const t of perTool) console.log(`  ${t.name.padEnd(26)} ${String(t.tokens).padStart(5)} tok`);
    console.log(`  ${"GRAND TOTAL".padEnd(26)} ${String(total.tokens).padStart(5)} tok`);

    assertWithinBudget(total.tokens, {
      label: "cross-ext grand total (12 tools)",
      max: 4400,
      baseline: 4148,
      measuredAt: "2026-07-14",
      commit: "feat/wire-distill",
    });
  });
});
