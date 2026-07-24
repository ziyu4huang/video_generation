import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Moved from pi-agent-ext-workflow/tests/extension-subagent-registration.test.ts
 * when the `subagent` + `subagent_runs` tools moved to THIS package
 * (pi-agent-ext-subagent). The factory under test is now
 * `../extensions/subagent.ts`; the assertion is broadened to cover BOTH tools
 * the extension owns.
 */
describe("subagent extension — tool registration", () => {
  it("registers tools named 'subagent' and 'subagent_runs' at load", async () => {
    const registered: ToolDefinition[] = [];
    // Permissive mock: record registerTool, no-op everything else the synchronous
    // load path touches (registerCommand, on, events, …). session_start handlers
    // are only registered (not fired) at load, so activation is covered by E2E.
    const pi = new Proxy(
      { events: { on: () => {}, emit: () => {} } },
      {
        get(target, prop) {
          if (prop === "registerTool")
            return (t: ToolDefinition) => {
              registered.push(t);
            };
          if (prop === "events") return target.events;
          if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
          return () => {};
        },
      },
    ) as unknown as ExtensionAPI;

    const { default: extension } = await import("../extensions/subagent.ts");
    extension(pi);

    const names = registered.map((t) => t.name);
    assert.ok(names.includes("subagent"), `expected 'subagent' registered; got: ${names.join(", ")}`);
    assert.ok(names.includes("subagent_runs"), `expected 'subagent_runs' registered; got: ${names.join(", ")}`);
  });
});
