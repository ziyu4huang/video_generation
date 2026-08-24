import { describe, expect, test } from "bun:test";
// devDependency import (test-side only — core-runtime stays runtime-zero-dep):
// drift-guards the duplicated key literal against the canonical registry.
import { SEAM_KEYS } from "@repo/s2-agent-core-interface";
import { BAKED_PROVIDERS_SEAM_KEY, registerBakedProvidersFromSeam } from "../src/agent-model.js";

describe("BAKED_PROVIDERS_SEAM_KEY drift guard", () => {
  test("the duplicated literal matches core-interface's canonical SEAM_KEYS registry", () => {
    // core-runtime owns its globalThis slot directly (zero-dep design), so a
    // rename in seam-keys.ts would silently blind this reader. The key is
    // registered in SEAM_KEYS (no-orphans invariant) — pin the pair.
    expect(SEAM_KEYS).toHaveProperty(BAKED_PROVIDERS_SEAM_KEY);
  });
});

/** Minimal registry double recording registerProvider calls. */
function fakeRegistry(throwOn?: string) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    registry: {
      registerProvider(name: string, config: unknown) {
        if (name === throwOn) throw new Error("boom");
        calls.push([name, config]);
      },
    },
  };
}

describe("registerBakedProvidersFromSeam", () => {
  test("unpublished seam → 0 registered, no calls, no throw", () => {
    const { calls, registry } = fakeRegistry();
    expect(registerBakedProvidersFromSeam(registry, () => undefined)).toBe(0);
    expect(calls).toEqual([]);
  });

  test("published catalog → every entry registered verbatim, count returned", () => {
    const catalog = {
      "lm-studio": {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        apiKey: "lm-studio",
        models: [],
      },
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        apiKey: "$DEEPSEEK_API_KEY",
        models: [],
      },
    };
    const { calls, registry } = fakeRegistry();
    expect(registerBakedProvidersFromSeam(registry, () => catalog)).toBe(2);
    expect(calls.map(([name]) => name).sort()).toEqual(["deepseek", "lm-studio"]);
    expect(calls[0]?.[1]).toBe(catalog["lm-studio"]); // verbatim, no re-shaping
  });

  test("non-object catalog (string/number/null) → 0, no throw", () => {
    const { calls, registry } = fakeRegistry();
    expect(registerBakedProvidersFromSeam(registry, () => "nope")).toBe(0);
    expect(registerBakedProvidersFromSeam(registry, () => 42)).toBe(0);
    expect(registerBakedProvidersFromSeam(registry, () => null)).toBe(0);
    expect(calls).toEqual([]);
  });

  test("malformed entry skipped with a warning; a throwing registerProvider skips that entry only", () => {
    const catalog = { good: { models: [] }, bad: "not-an-object", throws: { models: [] } };
    const { calls, registry } = fakeRegistry("throws");
    expect(registerBakedProvidersFromSeam(registry, () => catalog)).toBe(1);
    expect(calls.map(([name]) => name)).toEqual(["good"]);
  });

  test("default reader is globalThis (the real seam slot)", () => {
    const key = BAKED_PROVIDERS_SEAM_KEY as keyof typeof globalThis;
    const prev = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = { x: { models: [] } };
    try {
      const { calls, registry } = fakeRegistry();
      expect(registerBakedProvidersFromSeam(registry)).toBe(1);
      expect(calls.map(([name]) => name)).toEqual(["x"]);
    } finally {
      (globalThis as Record<string, unknown>)[key] = prev;
    }
  });
});
