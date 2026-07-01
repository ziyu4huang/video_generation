import { describe, expect, test } from "bun:test";
import { PROVIDERS, resolveApiKey } from "./pre-load-providers.ts";

describe("resolveApiKey", () => {
  test("literal string → returned as-is", () => {
    expect(resolveApiKey("lm-studio")).toBe("lm-studio");
    expect(resolveApiKey("")).toBe("");
  });

  test("{env} → reads process.env by default", () => {
    const KEY = "__PLP_PROBE_KEY";
    process.env[KEY] = "secret-value";
    try {
      expect(resolveApiKey({ env: KEY })).toBe("secret-value");
    } finally {
      delete process.env[KEY];
    }
  });

  test("{env} unset → empty string (not undefined)", () => {
    expect(resolveApiKey({ env: "__DEFINITELY_UNSET__" }, {})).toBe("");
  });

  test("{env} → uses the injected env, ignoring process.env (purity)", () => {
    const KEY = "__PLP_PROBE_KEY_2";
    process.env[KEY] = "from-real-env";
    try {
      expect(resolveApiKey({ env: KEY }, { [KEY]: "from-injected" })).toBe("from-injected");
      expect(resolveApiKey({ env: KEY }, {})).toBe(""); // injected {} ignores real env
    } finally {
      delete process.env[KEY];
    }
  });
});

describe("PROVIDERS config (contract)", () => {
  const entries = Object.entries(PROVIDERS);

  test("has at least one provider", () => {
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  test("every provider has a non-empty baseUrl + api", () => {
    for (const [name, p] of entries) {
      expect(typeof p.baseUrl).toBe("string");
      expect(p.baseUrl.length).toBeGreaterThan(0);
      expect(typeof p.api).toBe("string");
      expect(p.api.length).toBeGreaterThan(0);
      void name;
    }
  });

  test("lm-studio is configured with a localhost baseUrl + literal apiKey", () => {
    const lm = PROVIDERS["lm-studio"];
    expect(lm).toBeDefined();
    expect(lm.baseUrl).toMatch(/^http:\/\/localhost:/);
    expect(resolveApiKey(lm.apiKey)).toBe("lm-studio");
  });

  test("every model has the required fields with valid ranges", () => {
    for (const [, p] of entries) {
      expect(p.models.length).toBeGreaterThan(0);
      for (const m of p.models) {
        expect(typeof m.id).toBe("string");
        expect(m.id.length).toBeGreaterThan(0);
        expect(typeof m.name).toBe("string");
        expect(m.name.length).toBeGreaterThan(0);
        expect(typeof m.reasoning).toBe("boolean");
        expect(Array.isArray(m.input)).toBe(true);
        // input only contains "text" / "image"
        for (const i of m.input) expect(["text", "image"]).toContain(i);
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.maxTokens).toBeGreaterThan(0);
      }
    }
  });

  test("lm-studio models are multimodal (text+image) — VLM requires vision", () => {
    const lm = PROVIDERS["lm-studio"];
    for (const m of lm.models) {
      expect(m.input).toContain("image");
    }
  });
});
