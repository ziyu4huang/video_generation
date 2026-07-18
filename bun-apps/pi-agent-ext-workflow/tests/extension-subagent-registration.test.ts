import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("workflow extension — subagent tool registration", () => {
  it("registers a tool named 'subagent' at load", async () => {
    const registered: ToolDefinition[] = [];
    // Permissive mock: record registerTool, no-op everything else the synchronous
    // load path touches (registerCommand, on, events, …). session_start handlers
    // are only registered (not fired) at load, so activation is covered by E2E.
    const pi = new Proxy(
      { events: { on: () => {}, emit: () => {} } },
      {
        get(target, prop) {
          if (prop === "registerTool") return (t: ToolDefinition) => {
            registered.push(t);
          };
          if (prop === "events") return target.events;
          if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
          return () => {};
        },
      },
    ) as unknown as ExtensionAPI;

    const { default: extension } = await import("../extensions/workflow.js");
    extension(pi);

    const names = registered.map((t) => t.name);
    assert.ok(
      names.includes("subagent"),
      `expected 'subagent' registered; got: ${names.join(", ")}`,
    );
  });
});
