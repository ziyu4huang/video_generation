import { describe, expect, test } from "bun:test";
import { computeActiveTools, CORE_TOOLS } from "./tool-gate.ts";

describe("computeActiveTools", () => {
  test("a tool not listed in CORE_TOOLS or any gate is always active (fail-open)", () => {
    const allTools = [...CORE_TOOLS, "some_future_tool_not_in_any_gate"];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("", allTools, sticky);
    expect(active).toContain("some_future_tool_not_in_any_gate");
  });

  test("a gate stays active across turns even when a later prompt doesn't mention it", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    const turn1 = computeActiveTools("generate an image of a cat", allTools, sticky);
    expect(turn1).toContain("flux2");
    const turn2 = computeActiveTools("make it bigger", allTools, sticky);
    expect(turn2).toContain("flux2");
    expect(turn2).toContain("flux2_help");
  });

  test("a gate never mentioned by any prompt stays inactive", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("what's the weather", allTools, sticky);
    expect(active).not.toContain("flux2");
    expect(active).not.toContain("flux2_help");
  });

  test("CORE_TOOLS are always active regardless of prompt", () => {
    const allTools = [...CORE_TOOLS];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("irrelevant prompt", allTools, sticky);
    for (const t of CORE_TOOLS) expect(active).toContain(t);
  });
});
