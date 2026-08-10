import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { superpowersExtension } from "../src/index.ts";

// Self-gate mirror of prompt-history.test.ts: BUN_PI_SUPERPOWERS=0 must make the
// factory register nothing (no event hooks — no tools/commands at all in this
// extension). Named import from src matches the skill-exclude.test.ts precedent;
// `superpowersExtension` is the factory that carries the gate.

const ENV_KEY = "BUN_PI_SUPERPOWERS";
const saved = process.env[ENV_KEY];

type Handler = (event: any, ctx?: any) => any;
function makeMockPi() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendUserMessage: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("BUN_PI_SUPERPOWERS=0 self-gate", () => {
  it("registers nothing when disabled", () => {
    process.env[ENV_KEY] = "0";
    const { pi, handlers } = makeMockPi();
    expect(() => superpowersExtension(pi)).not.toThrow();
    expect(handlers.size).toBe(0);
  });

  it("wires up when enabled (default)", () => {
    delete process.env[ENV_KEY];
    const { pi, handlers } = makeMockPi();
    superpowersExtension(pi);
    expect(handlers.size).toBeGreaterThan(0);
  });
});
