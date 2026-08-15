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

  it("force-activates 'subagent' + 'subagent_runs' on session_start and before_agent_start", async () => {
    // Richer mock than the registration test: records setActiveTools calls and
    // captures lifecycle handlers so we can fire session_start / before_agent_start
    // and assert the extension force-activates its tools (Task 4 review fix).
    const registered: ToolDefinition[] = [];
    const registeredCommands: string[] = [];
    const setActiveToolsCalls: string[][] = [];
    let active: string[] = ["always_on_tool"];
    const handlers: Record<string, ((...args: unknown[]) => void) | undefined> = {};
    const pi = {
      registerTool: (t: ToolDefinition) => {
        registered.push(t);
      },
      registerCommand: ((name: string) => {
        registeredCommands.push(name);
      }) as never,
      registerShortcut: (() => {}) as never,
      getActiveTools: () => active,
      setActiveTools: (tools: string[]) => {
        setActiveToolsCalls.push([...tools]);
        active = [...tools];
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      },
      events: { on: () => {}, emit: () => {} },
      getAllToolDefinitions: () => [] as ToolDefinition[],
    } as unknown as ExtensionAPI;

    const { default: extension } = await import("../extensions/subagent.ts");
    extension(pi);

    // session_start fires first (captures tools/model), then before_agent_start
    // fires per-turn. Both precede a system-prompt rebuild.
    handlers.session_start?.({}, { model: undefined });
    handlers.before_agent_start?.({});

    const names = registered.map((t) => t.name);
    assert.ok(names.includes("subagent"), `expected 'subagent' registered; got: ${names.join(", ")}`);
    assert.ok(names.includes("subagent_runs"), `expected 'subagent_runs' registered; got: ${names.join(", ")}`);

    // At least one setActiveTools call must include BOTH owned tools. session_start
    // is the first hook to fire, so it carries the activation here.
    const sawBoth = setActiveToolsCalls.some((call) => call.includes("subagent") && call.includes("subagent_runs"));
    assert.ok(
      sawBoth,
      `expected a setActiveTools call containing both 'subagent' and 'subagent_runs'; got: ${JSON.stringify(setActiveToolsCalls)}`,
    );

    // And the active set must end up containing both (idempotent re-activation on
    // before_agent_start must not drop them).
    assert.ok(active.includes("subagent"), `expected 'subagent' in active set; got: ${JSON.stringify(active)}`);
    assert.ok(
      active.includes("subagent_runs"),
      `expected 'subagent_runs' in active set; got: ${JSON.stringify(active)}`,
    );

    // The /subagents command registration moved here with the viewer (self-contained).
    assert.ok(
      registeredCommands.includes("subagents"),
      `expected '/subagents' command registered; got: ${JSON.stringify(registeredCommands)}`,
    );
  });
});
