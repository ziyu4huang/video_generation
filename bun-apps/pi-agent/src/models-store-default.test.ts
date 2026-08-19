/** models-store-default — unit tests for the built-in catalog + seed helpers. */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MODELS_STORE,
	buildModelsStoreJson,
	shouldEnsureModelsStore,
} from "./models-store-default.ts";

describe("DEFAULT_MODELS_STORE — the curated provider catalog", () => {
  test("covers the providers the built-in defaults resolve against", () => {
    // zai hosts the built-in default model; deepseek hosts the obsidian
    // subagent floor (src/builtin-model-default.ts).
    expect(Object.keys(DEFAULT_MODELS_STORE)).toContain("zai");
    expect(Object.keys(DEFAULT_MODELS_STORE)).toContain("deepseek");
  });

  test("zai catalog contains the built-in default model glm-5.3", () => {
    const ids = DEFAULT_MODELS_STORE.zai.models.map((m) => m.id);
    expect(ids).toContain("glm-5.3");
  });

  test("deepseek catalog contains the obsidian floor model deepseek-v4-flash", () => {
    const ids = DEFAULT_MODELS_STORE.deepseek.models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash");
  });

  test("every provider entry has a non-empty models list", () => {
    for (const [provider, entry] of Object.entries(DEFAULT_MODELS_STORE)) {
      expect(entry.models.length, provider).toBeGreaterThan(0);
    }
  });
});

describe("buildModelsStoreJson", () => {
  test("round-trips through JSON.parse unchanged", () => {
    const parsed = JSON.parse(buildModelsStoreJson());
    expect(parsed).toEqual(DEFAULT_MODELS_STORE);
  });

  test("ends with a newline (POSIX-friendly file)", () => {
    expect(buildModelsStoreJson().endsWith("\n")).toBe(true);
  });
});

describe("shouldEnsureModelsStore", () => {
  test("absent + enabled → seed", () => {
    expect(shouldEnsureModelsStore({ fileExists: false, enabled: true })).toBe(true);
  });

  test("existing file → never (no clobber)", () => {
    expect(shouldEnsureModelsStore({ fileExists: true, enabled: true })).toBe(false);
  });

  test("disabled → never", () => {
    expect(shouldEnsureModelsStore({ fileExists: false, enabled: false })).toBe(false);
  });
});
