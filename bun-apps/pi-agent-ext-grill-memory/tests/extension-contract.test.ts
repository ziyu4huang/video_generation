/**
 * extension-contract — local regression guard: this package's extension
 * factory must load under pi-agent's real extension protocol without
 * throwing. Mirrors bun-apps/pi-agent/src/__tests__/extension-contract.test.ts's
 * mock `pi`, scoped to just this package so a break here fails locally
 * (bun test in this package) instead of only being caught centrally in
 * pi-agent.
 *
 * NOTE: unlike most packages in this monorepo, this extension's factory is
 * documented (see extensions/index.ts) as an intentional no-op — it exists
 * only so the Pi manifest is valid and the `grill-memory` skill ships; all
 * runtime behavior (the `grill_decision` tool) lives in
 * pi-agent-ext-hermes-memory. Consistent with that, this package's
 * extension entry is NOT listed in pi-agent's manifest.json `extensions`
 * array (only its `skills` dir is), so it is never loaded by the central
 * cross-extension "(b) every extension wires up" gate either. This test
 * therefore asserts (a) load-safety and that any tool/command that *is*
 * registered is well-formed, without requiring >=1 registration.
 */
import { describe, expect, test } from "bun:test";
import extensionFactory from "../extensions/index.ts";

interface ToolLike {
  name?: string;
  label?: string;
  description?: string;
  [key: string]: unknown;
}
interface CommandLike {
  name?: string;
  handler?: unknown;
}

function makeMockPi() {
  const tools: ToolLike[] = [];
  const commands: CommandLike[] = [];
  const pi = {
    registerTool: (t: ToolLike) => {
      tools.push(t);
      return t;
    },
    registerCommand: (name: string, opts: CommandLike) => {
      commands.push({ name, handler: opts.handler });
    },
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    sendMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setActiveTools: () => {},
    getActiveTools: () => [] as string[],
    getFlag: () => undefined,
    setModel: async () => true,
    on: () => {},
    events: { on: () => () => {}, emit: () => {} },
    getAllTools: () => tools,
    exec: async () => "",
    sendUserMessage: () => {},
  };
  return { pi, tools, commands };
}

describe("pi-agent-ext-grill-memory extension contract", () => {
  test("factory loads without throwing", () => {
    const { pi } = makeMockPi();
    expect(() => extensionFactory(pi as never)).not.toThrow();
  });

  test("every registered tool has a non-empty name/label/description", () => {
    const { pi, tools } = makeMockPi();
    extensionFactory(pi as never);
    for (const t of tools) {
      expect(t.name, `tool missing name: ${JSON.stringify(t)}`).toBeTruthy();
      expect(t.label, `tool "${t.name}" missing label`).toBeTruthy();
      expect(t.description, `tool "${t.name}" missing description`).toBeTruthy();
    }
  });

  test("every registered command has a handler function", () => {
    const { pi, commands } = makeMockPi();
    extensionFactory(pi as never);
    for (const c of commands) {
      expect(typeof c.handler, `command "${c.name}" missing handler`).toBe("function");
    }
  });
});
