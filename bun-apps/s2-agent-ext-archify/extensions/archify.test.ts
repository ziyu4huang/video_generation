import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import extension from "./archify.ts";

// Self-gate mirror of wayfind.test.ts: BUN_PI_ARCHIFY=0 must make the factory
// register nothing. The factory is imported directly from the entry so this
// exercises the exact body that carries the gate (enforced repo-wide by
// bun-apps/tests/extension-isolation-contract.test.ts).

const ENV_KEY = "BUN_PI_ARCHIFY";
const saved = process.env[ENV_KEY];

type Pi = Parameters<ExtensionFactory>[0];

function makeMockPi() {
  const names: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => {
      names.push(tool.name);
    },
    sendUserMessage: () => {},
    notify: () => {},
    setStatus: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as Pi;
  return { pi, names };
}

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("BUN_PI_ARCHIFY=0 self-gate", () => {
  it("registers nothing when disabled", () => {
    process.env[ENV_KEY] = "0";
    const { pi, names } = makeMockPi();
    expect(() => extension(pi)).not.toThrow();
    expect(names).toEqual([]);
  });

  it("registers all five tools when enabled (default)", () => {
    delete process.env[ENV_KEY];
    const { pi, names } = makeMockPi();
    extension(pi);
    expect(names).toEqual([
      "archify_validate",
      "archify_render",
      "archify_delta",
      "archify_export_pptx",
      "archify_deck_lint",
    ]);
  });
});
