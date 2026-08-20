import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import wayfindExtension from "../src/index.ts";

// Self-gate mirror of prompt-history.test.ts: BUN_PI_WAYFIND=0 must make the
// factory register nothing (no commands, no tool, no event hooks). The factory
// is imported directly from src (the `extensions/wayfind.ts` entry wraps rather
// than re-exports it) so this exercises the exact body that carries the gate.

const ENV_KEY = "BUN_PI_WAYFIND";
const saved = process.env[ENV_KEY];

function makeMockPi() {
  const calls = { on: 0, registerTool: 0, registerCommand: 0 };
  const pi = {
    on: () => {
      calls.on++;
    },
    registerTool: () => {
      calls.registerTool++;
    },
    registerCommand: () => {
      calls.registerCommand++;
    },
    sendUserMessage: () => {},
    notify: () => {},
    setStatus: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("BUN_PI_WAYFIND=0 self-gate", () => {
  it("registers nothing when disabled", () => {
    process.env[ENV_KEY] = "0";
    const { pi, calls } = makeMockPi();
    expect(() => wayfindExtension(pi)).not.toThrow();
    expect(calls.on).toBe(0);
    expect(calls.registerTool).toBe(0);
    expect(calls.registerCommand).toBe(0);
  });

  it("wires up when enabled (default)", () => {
    delete process.env[ENV_KEY];
    const { pi, calls } = makeMockPi();
    wayfindExtension(pi);
    expect(calls.on + calls.registerTool + calls.registerCommand).toBeGreaterThan(0);
  });
});
