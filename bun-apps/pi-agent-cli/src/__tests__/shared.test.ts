import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
	validateToolNames,
	modelLabel,
	buildBakedRegistry,
	applyObsidianSubagentFloor,
} from "../sessions/shared.ts";

/** Minimal stand-in for a pi-core session: only getActiveToolNames is used. */
function mockSession(active: string[]): { getActiveToolNames: () => string[] } {
  return { getActiveToolNames: () => active };
}

describe("validateToolNames — fail-fast on unknown --tools", () => {
  test("undefined requested → no throw", () => {
    expect(() => validateToolNames(mockSession(["read"]), undefined, undefined)).not.toThrow();
  });

  test("empty requested → no throw", () => {
    expect(() => validateToolNames(mockSession(["read"]), [], undefined)).not.toThrow();
  });

  test("all requested names are active → no throw", () => {
    expect(() =>
      validateToolNames(mockSession(["read", "bash", "obsidian_read"]), ["read", "bash"], undefined),
    ).not.toThrow();
  });

  test("typo'd name (not active) → throws and names it", () => {
    expect(() =>
      validateToolNames(mockSession(["read", "bash"]), ["obsidian_distil", "obsidian_reed"], undefined),
    ).toThrow(/obsidian_distil[\s\S]*obsidian_reed/);
  });

  test("mixed valid + typo → throws listing only the typo", () => {
    const fn = () => validateToolNames(mockSession(["read", "bash"]), ["read", "obsidian_distil"], undefined);
    expect(fn).toThrow();
    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("obsidian_distil");
      expect(msg).not.toMatch(/\bread\b/); // valid name not flagged
    }
  });

  test("name absent from active BUT in excludeTools → NOT flagged (exclusion explains absence)", () => {
    // `--tools read,bash --exclude-tools bash` → bash not active, but excluded → OK.
    expect(() =>
      validateToolNames(mockSession(["read"]), ["read", "bash"], ["bash"]),
    ).not.toThrow();
  });

  test("error message points the user at --list-tools", () => {
    try {
      validateToolNames(mockSession(["read"]), ["bogus"], undefined);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/--list-tools/);
    }
  });

  test("session without getActiveToolNames → no throw (cannot validate, don't block)", () => {
    expect(() => validateToolNames({} as never, ["bogus"], undefined)).not.toThrow();
  });
});

describe("modelLabel — display name with provider/id fallback", () => {
  const llm = { provider: "zai", modelId: "glm-5.2" };

  test("uses the registry display name when present", () => {
    expect(modelLabel({ model: { name: "GLM 5.2" } }, llm)).toBe("GLM 5.2");
  });

  test("falls back to provider/modelId when no display name", () => {
    expect(modelLabel({}, llm)).toBe("zai/glm-5.2");
    expect(modelLabel({ model: {} }, llm)).toBe("zai/glm-5.2");
  });
});

describe("buildBakedRegistry — pi-agent PROVIDERS baked in", () => {
  const BAKED_BASE_URL = "http://localhost:1234/v1";
  const ENV_BACKUP: Record<string, string | undefined> = {};

  beforeEach(() => {
    ENV_BACKUP.PI_SKIP_MODELS_JSON = process.env.PI_SKIP_MODELS_JSON;
    delete process.env.PI_SKIP_MODELS_JSON;
  });

  afterEach(() => {
    if (ENV_BACKUP.PI_SKIP_MODELS_JSON === undefined) {
      delete process.env.PI_SKIP_MODELS_JSON;
    } else {
      process.env.PI_SKIP_MODELS_JSON = ENV_BACKUP.PI_SKIP_MODELS_JSON;
    }
  });

  test("baked lm-studio is registered with the pi-agent catalog + zero cost", async () => {
    const { modelRegistry } = await buildBakedRegistry();
    const m = modelRegistry.find("lm-studio", "google/gemma-4-12b-qat");
    expect(m).toBeDefined();
    expect(m!.baseUrl).toBe(BAKED_BASE_URL);
    expect(m!.reasoning).toBe(true);
    expect(m!.input).toContain("image");
    expect(m!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // baked apiKey is inline → hasConfiguredAuth holds
    expect(modelRegistry.hasConfiguredAuth(m!)).toBe(true);
  });

  test("PI_SKIP_MODELS_JSON=1 → hermetic: in-memory auth + still baked", async () => {
    process.env.PI_SKIP_MODELS_JSON = "1";
    const { modelRuntime, modelRegistry } = await buildBakedRegistry();
    // in-memory credential store has no file backend
    expect(typeof modelRuntime.getAuth).toBe("function");
    // baked lm-studio still present in hermetic mode
    const m = modelRegistry.find("lm-studio", "google/gemma-4-12b-qat");
    expect(m).toBeDefined();
    expect(m!.baseUrl).toBe(BAKED_BASE_URL);
  });
});

describe("applyObsidianSubagentFloor — inject OB_SUBAGENT_MODEL from settings", () => {
  const ENV_BACKUP: Record<string, string | undefined> = {};

  beforeEach(() => {
    ENV_BACKUP.OB_SUBAGENT_MODEL = process.env.OB_SUBAGENT_MODEL;
    delete process.env.OB_SUBAGENT_MODEL;
  });

  afterEach(() => {
    if (ENV_BACKUP.OB_SUBAGENT_MODEL === undefined) {
      delete process.env.OB_SUBAGENT_MODEL;
    } else {
      process.env.OB_SUBAGENT_MODEL = ENV_BACKUP.OB_SUBAGENT_MODEL;
    }
  });

  test("sets OB_SUBAGENT_MODEL from settings.obsidian.subagentModel", () => {
    applyObsidianSubagentFloor({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } });
    expect(process.env.OB_SUBAGENT_MODEL).toBe("deepseek/deepseek-v4-flash");
  });

  test("trims whitespace around the floor value", () => {
    applyObsidianSubagentFloor({ obsidian: { subagentModel: "  deepseek/deepseek-v4-flash  " } });
    expect(process.env.OB_SUBAGENT_MODEL).toBe("deepseek/deepseek-v4-flash");
  });

  test("existing OB_SUBAGENT_MODEL env var wins (per-session override)", () => {
    process.env.OB_SUBAGENT_MODEL = "zai/glm-5.2";
    applyObsidianSubagentFloor({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } });
    expect(process.env.OB_SUBAGENT_MODEL).toBe("zai/glm-5.2");
  });

  test("undefined settings → no-op (no env set)", () => {
    applyObsidianSubagentFloor(undefined);
    expect(process.env.OB_SUBAGENT_MODEL).toBeUndefined();
  });

  test("missing obsidian.subagentModel field → no-op", () => {
    applyObsidianSubagentFloor({ defaultModel: "glm-5.2", subagents: {} });
    expect(process.env.OB_SUBAGENT_MODEL).toBeUndefined();
  });

  test("non-string / empty floor → no-op", () => {
    applyObsidianSubagentFloor({ obsidian: { subagentModel: 123 } });
    expect(process.env.OB_SUBAGENT_MODEL).toBeUndefined();
    applyObsidianSubagentFloor({ obsidian: { subagentModel: "   " } });
    expect(process.env.OB_SUBAGENT_MODEL).toBeUndefined();
  });
});
