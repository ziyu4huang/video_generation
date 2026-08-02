import { describe, expect, test } from "bun:test";
import { makeInspectHooksTool } from "../inspect-hooks.ts";
import {
  makeInspectContextTool,
  makeInspectAgentTool,
  makeInspectExtensionsTool,
  makeInspectTuiTool,
} from "../../index.ts";
import { makeInspectPathologyTool } from "../../pathology/index.ts";

// The verbatim gating every inspect_* tool must carry. Lifted from tool-gate's
// former hardcoded inspect_* gate (now removed from GATES — the group is fully
// owner-declared by these literals). Do NOT re-tune.
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
 * real signature and assert the returned definition carries `gating`.
 */
describe("inspect_* tools carry owner-declared gating", () => {
  test("inspect_context declares gating (keywords+requires, verbatim)", () => {
    const tool = makeInspectContextTool(() => []);
    expect(tool.name).toBe("inspect_context");
    expect(tool.gating).toBeDefined();
    expect(tool.gating!.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(tool.gating!.requires).toEqual(EXPECTED_GATING.requires);
  });

  test("inspect_agent declares gating (keywords+requires, verbatim)", () => {
    const tool = makeInspectAgentTool(() => []);
    expect(tool.name).toBe("inspect_agent");
    expect(tool.gating).toBeDefined();
    expect(tool.gating!.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(tool.gating!.requires).toEqual(EXPECTED_GATING.requires);
  });

  test("inspect_extensions declares gating (keywords+requires, verbatim)", () => {
    const tool = makeInspectExtensionsTool(() => []);
    expect(tool.name).toBe("inspect_extensions");
    expect(tool.gating).toBeDefined();
    expect(tool.gating!.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(tool.gating!.requires).toEqual(EXPECTED_GATING.requires);
  });

  test("inspect_tui declares gating (keywords+requires, verbatim)", () => {
    const tool = makeInspectTuiTool();
    expect(tool.name).toBe("inspect_tui");
    expect(tool.gating).toBeDefined();
    expect(tool.gating!.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(tool.gating!.requires).toEqual(EXPECTED_GATING.requires);
  });

  test("inspect_pathology declares gating (keywords+requires, verbatim)", () => {
    const tool = makeInspectPathologyTool();
    expect(tool.name).toBe("inspect_pathology");
    expect(tool.gating).toBeDefined();
    expect(tool.gating!.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(tool.gating!.requires).toEqual(EXPECTED_GATING.requires);
  });

  test("inspect_hooks declares gating (orphan-fix: previously registered but in no gate)", () => {
    // inspect_hooks was ORPHANED: registered by the extension but absent from
    // tool-gate's GATES → never gated. Now it carries gating by construction.
    const tool = makeInspectHooksTool();
    expect(tool.name).toBe("inspect_hooks");
    expect(tool.gating).toBeDefined();
    expect(tool.gating!.keywords).toEqual(EXPECTED_GATING.keywords);
    expect(tool.gating!.requires).toEqual(EXPECTED_GATING.requires);
  });
});
