import { afterEach, describe, expect, test } from "bun:test";
import { ALL_TOOL_DEFINITIONS_GLOBAL, readAllToolDefinitions } from "../read-all-tool-definitions.js";

/**
 * readAllToolDefinitions — the two-source compat read that healed the pi
 * 0.84.2 extension-tools regression (cc-parity-2 ticket 01 live smoke:
 * api-level getAllToolDefinitions went dead with the fixed-shape
 * ExtensionAPI, silently stripping every parent extension tool from spawned
 * children). Pins the precedence and the empty/absent semantics.
 */

const TOOL = { name: "send_message", execute: () => {} } as never;

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ALL_TOOL_DEFINITIONS_GLOBAL];
});

describe("readAllToolDefinitions", () => {
  test("api source wins when present", () => {
    (globalThis as Record<string, unknown>)[ALL_TOOL_DEFINITIONS_GLOBAL] = () => [{ name: "from-global" } as never];
    const pi = { getAllToolDefinitions: () => [TOOL] };
    expect(readAllToolDefinitions(pi)).toEqual([TOOL]);
  });

  test("falls back to the globalThis bridge when the api method is absent", () => {
    (globalThis as Record<string, unknown>)[ALL_TOOL_DEFINITIONS_GLOBAL] = () => [TOOL];
    expect(readAllToolDefinitions({})).toEqual([TOOL]);
  });

  test("empty api result falls through to the global (api shape exists but holds nothing)", () => {
    (globalThis as Record<string, unknown>)[ALL_TOOL_DEFINITIONS_GLOBAL] = () => [TOOL];
    expect(readAllToolDefinitions({ getAllToolDefinitions: () => [] })).toEqual([TOOL]);
  });

  test("both absent/empty → undefined (callers must read this as 'bridge empty')", () => {
    expect(readAllToolDefinitions({})).toBeUndefined();
    expect(readAllToolDefinitions({ getAllToolDefinitions: () => [] })).toBeUndefined();
    (globalThis as Record<string, unknown>)[ALL_TOOL_DEFINITIONS_GLOBAL] = () => [];
    expect(readAllToolDefinitions({})).toBeUndefined();
  });
});
