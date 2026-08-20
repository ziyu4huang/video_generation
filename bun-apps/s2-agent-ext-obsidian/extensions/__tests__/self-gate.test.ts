import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "../obsidian.ts";

// Self-gate mirror of superpowers.test.ts: BUN_PI_OBSIDIAN=0 must make the
// factory register nothing (no tools, commands, or session hooks). Direct
// default-import from the entry — the gate lives in the entry factory, so the
// test must call THAT, not a src/ re-export.

const ENV_KEY = "BUN_PI_OBSIDIAN";
const saved = process.env[ENV_KEY];

type Handler = (event: any, ctx?: any) => any;
function makeMockPi() {
  const handlers = new Map<string, Handler>();
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: (t: { name: string }) => {
      tools.push(t.name);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
    sendUserMessage: () => {},
    notify: () => {},
    setStatus: () => {},
    getAllTools: () => [],
    getCommands: () => [],
    getAllToolDefinitions: () => [],
    appendEntry: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, commands };
}

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("BUN_PI_OBSIDIAN=0 self-gate", () => {
  it("registers nothing when disabled", async () => {
    process.env[ENV_KEY] = "0";
    const { pi, handlers, tools, commands } = makeMockPi();
    await factory(pi);
    expect(handlers.size).toBe(0);
    expect(tools).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  it("registers the fat tool + commands when enabled (default)", async () => {
    delete process.env[ENV_KEY];
    const { pi, tools, commands } = makeMockPi();
    await factory(pi);
    expect(tools).toContain("obsidian");
    expect(commands).toContain("obsidian");
    expect(commands).toContain("obsidian-config");
  });
});
