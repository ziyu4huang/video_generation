import { describe, expect, test } from "bun:test";
import { makeInspectHooksTool } from "../inspect-hooks.ts";
import {
  makeInspectContextTool,
  makeInspectAgentTool,
  makeInspectExtensionsTool,
  makeInspectTuiTool,
} from "../../index.ts";
import { makeInspectPathologyTool } from "../../pathology/index.ts";

/**
 * Each inspect_* tool is built by a `makeInspectXxxTool(...)` factory returning a
 * `defineTool({...})` (a `ToolDefinition`). The 3 enumerating tools
 * (context/agent/extensions) take a `getAllTools: () => ToolInfo[]` callback;
 * the other 3 (tui/pathology/hooks) take none. We invoke each factory with its
 * real signature and assert the returned definition is owner-declared CORE
 * (always-on) — wayfinder ticket 06, HITL decision 2026-08-16: diagnostics are
 * the exact tools needed when something is wrong, so keyword-gating them was
 * a footgun; they are now core:true (the former "inspect" gate family +
 * DIAGNOSTIC_GATING in src/gating.ts are retired — see that file's header).
 */
describe("inspect_* tools are owner-declared CORE (ticket 06 un-gate)", () => {
  const tools = [
    { name: "inspect_context", tool: makeInspectContextTool(() => []) },
    { name: "inspect_agent", tool: makeInspectAgentTool(() => []) },
    { name: "inspect_extensions", tool: makeInspectExtensionsTool(() => []) },
    { name: "inspect_tui", tool: makeInspectTuiTool() },
    { name: "inspect_pathology", tool: makeInspectPathologyTool() },
    { name: "inspect_hooks", tool: makeInspectHooksTool() },
  ];

  for (const { name, tool } of tools) {
    test(`${name} carries gating: { core: true } (always-on, no keyword incantation)`, () => {
      expect(tool.name).toBe(name);
      expect(tool.gating).toBeDefined();
      expect(tool.gating!.core).toBe(true); // ticket 06: diagnostics always-on
      expect(tool.gating!.gate).toBeUndefined(); // no gate reference anymore
    });
  }
});
