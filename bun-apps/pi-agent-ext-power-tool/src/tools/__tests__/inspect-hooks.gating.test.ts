import { describe, expect, test } from "bun:test";
import { makeInspectHooksTool } from "../inspect-hooks.ts";
import {
  makeInspectContextTool,
  makeInspectAgentTool,
  makeInspectExtensionsTool,
  makeInspectTuiTool,
} from "../../index.ts";
import { makeInspectPathologyTool } from "../../pathology/index.ts";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";

// The verbatim gating every inspect_* tool shares via the "inspect" family.
// Lifted from tool-gate's former hardcoded inspect_* gate (now removed from
// GATES — the group is fully owner-declared). Do NOT re-tune.
const EXPECTED_GATING = {
  keywords: [
    "schema cost",
    "pathology",
    "extension health",
    "工具開銷",
    "context window",
    "token usage",
  ],
  requires: {
    nouns: [
      "agent",
      "context",
      "extension",
      "pathology",
      "token",
      "schema",
      "tui",
      "工具",
    ],
    verbs: ["inspect", "show", "check", "diagnose", "dump", "report"],
  },
};

/**
 * Each inspect_* tool is built by a `makeInspectXxxTool(...)` factory returning a
 * `defineTool({...})` (a `ToolDefinition`). The 3 enumerating tools
 * (context/agent/extensions) take a `getAllTools: () => ToolInfo[]` callback;
 * the other 3 (tui/pathology/hooks) take none. We invoke each factory with its
 * real signature and assert the returned definition references the "inspect"
 * family (wayfinder ticket 01 reference form), whose spec lives in GATE_DEFS.
 */
describe("inspect_* tools reference the 'inspect' gate family (ticket 01)", () => {
  const tools = [
    { name: "inspect_context", tool: makeInspectContextTool(() => []) },
    { name: "inspect_agent", tool: makeInspectAgentTool(() => []) },
    { name: "inspect_extensions", tool: makeInspectExtensionsTool(() => []) },
    { name: "inspect_tui", tool: makeInspectTuiTool() },
    { name: "inspect_pathology", tool: makeInspectPathologyTool() },
    { name: "inspect_hooks", tool: makeInspectHooksTool() },
  ];

  test("the 'inspect' family is declared in GATE_DEFS with the verbatim spec", () => {
    const spec = GATE_DEFS["inspect"];
    expect(spec).toBeDefined();
    expect(spec!.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(spec!.requires).toEqual(EXPECTED_GATING.requires);
  });

  for (const { name, tool } of tools) {
    test(`${name} references the "inspect" family (gating: { gate: "inspect" })`, () => {
      expect(tool.name).toBe(name);
      expect(tool.gating).toBeDefined();
      // Reference form (01c): the tool only carries the family id — keywords/
      // requires live in GATE_DEFS, NOT on the tool's gating field.
      expect(tool.gating!.gate).toBe("inspect");
      expect("keywords" in (tool.gating as object)).toBe(false);
      expect("requires" in (tool.gating as object)).toBe(false);
    });
  }
});
