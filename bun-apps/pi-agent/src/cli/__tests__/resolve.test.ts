/**
 * shared.ts — LLM + model resolution (resolveLLM, isThinkingLevel, allModels,
 * resolveModel).
 *
 * validateToolNames + modelLabel are covered in shared.test.ts. This file pins
 * the resolution layer: resolveLLM (the provider/model/thinking grammar shared
 * with pi-file2md, flagged for extraction into a shared module) and resolveModel
 * (exact → substring → throw). All pure (resolveLLM reads PI_* env at call
 * time; resolveModel takes a fake registry). No network / no real services.
 *
 *   bun test src/cli/__tests__/resolve.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveLLM,
  isThinkingLevel,
  allModels,
  resolveModel,
} from "../sessions/shared.ts";

// resolveLLM reads PI_PROVIDER / PI_MODEL / PI_THINKING at call time.
const ENV_KEYS = ["PI_PROVIDER", "PI_MODEL", "PI_THINKING"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("isThinkingLevel", () => {
  test("accepts the 6 documented levels", () => {
    for (const v of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      expect(isThinkingLevel(v)).toBe(true);
    }
  });
  test("rejects unknown values + case variants", () => {
    expect(isThinkingLevel("bogus")).toBe(false);
    expect(isThinkingLevel("HIGH")).toBe(false); // case-sensitive
    expect(isThinkingLevel("")).toBe(false);
  });
});

describe("resolveLLM — defaults (no opts, no env)", () => {
  test("falls back to the built-in default target (zai / glm-5.3 / high)", () => {
    const r = resolveLLM({});
    expect(r.provider).toBe("zai");
    expect(r.modelId).toBe("glm-5.3");
    expect(r.thinkingLevel).toBe("high");
  });
});

describe("resolveLLM — env fallbacks", () => {
  test("PI_PROVIDER sets the provider", () => {
    process.env.PI_PROVIDER = "anthropic";
    const r = resolveLLM({});
    expect(r.provider).toBe("anthropic");
  });

  test("PI_MODEL sets the model id (provider unchanged when no slash)", () => {
    process.env.PI_MODEL = "claude-opus";
    const r = resolveLLM({});
    expect(r.modelId).toBe("claude-opus");
    expect(r.provider).toBe("zai"); // FALLBACK provider
  });

  test("PI_THINKING sets the thinking level", () => {
    process.env.PI_THINKING = "high";
    const r = resolveLLM({});
    expect(r.thinkingLevel).toBe("high");
  });
});

describe("resolveLLM — userDefaults (3rd-tier fallback)", () => {
  test("userDefaults apply when no opt + no env", () => {
    const r = resolveLLM({ userDefaults: { provider: "openai", model: "gpt-4o" } });
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4o");
  });

  test("env beats userDefaults", () => {
    process.env.PI_PROVIDER = "anthropic";
    process.env.PI_MODEL = "claude";
    const r = resolveLLM({ userDefaults: { provider: "openai", model: "gpt-4o" } });
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude");
  });

  test("explicit opt beats userDefaults + env", () => {
    process.env.PI_PROVIDER = "anthropic";
    const r = resolveLLM({
      provider: "zai",
      userDefaults: { provider: "openai" },
    });
    expect(r.provider).toBe("zai");
  });
});

describe("resolveLLM — --model shorthand", () => {
  test("'provider/id' splits on the first slash and overrides provider", () => {
    process.env.PI_PROVIDER = "anthropic";
    const r = resolveLLM({ model: "lm-studio/qwen-vl" });
    expect(r.provider).toBe("lm-studio");
    expect(r.modelId).toBe("qwen-vl");
  });

  test("'provider/id:thinking' strips the suffix and sets the level", () => {
    const r = resolveLLM({ model: "anthropic/claude-x:high" });
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude-x");
    expect(r.thinkingLevel).toBe("high");
  });

  test("slash-less id leaves provider untouched", () => {
    process.env.PI_PROVIDER = "openai";
    const r = resolveLLM({ model: "gpt-4o-mini" });
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4o-mini");
  });

  test("unknown ':token' suffix is kept in modelId (not parsed as thinking)", () => {
    const r = resolveLLM({ model: "foo/bar:notalevel" });
    expect(r.provider).toBe("foo");
    expect(r.modelId).toBe("bar:notalevel");
    expect(r.thinkingLevel).toBe("high"); // built-in default
  });

  test("colon with NO slash is not treated as a thinking separator", () => {
    // raw="foo:bar": colon(3) > indexOf("/")(-1) is true, but "bar" is not a
    // level → modelId keeps the whole raw string including the colon.
    const r = resolveLLM({ model: "foo:bar" });
    expect(r.modelId).toBe("foo:bar");
    // provider unchanged (no slash to split on).
    expect(r.provider).toBe("zai");
  });

  test("explicit --thinking beats the ':suffix'", () => {
    const r = resolveLLM({ model: "x/y:high", thinking: "low" });
    expect(r.thinkingLevel).toBe("low");
  });

  test("--model overrides PI_MODEL", () => {
    process.env.PI_MODEL = "env-model";
    const r = resolveLLM({ model: "opt/other" });
    expect(r.modelId).toBe("other");
  });
});

describe("resolveLLM — --thinking validation", () => {
  test("invalid --thinking throws and lists valid levels", () => {
    try {
      resolveLLM({ thinking: "bogus" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Invalid --thinking level: "bogus"/);
      expect(msg).toContain("off");
      expect(msg).toContain("xhigh");
    }
  });

  test("valid --thinking is accepted even with env present", () => {
    process.env.PI_THINKING = "high";
    expect(resolveLLM({ thinking: "minimal" }).thinkingLevel).toBe("minimal");
  });
});

describe("resolveLLM — PI_THINKING env validation", () => {
  // The --thinking flag and the :thinking model suffix are both validated;
  // PI_THINKING used to be `as ThinkingLevel`'d raw, letting PI_THINKING=bogus
  // reach createAgentSessionFromServices with no error (fail-fast gap).

  test("invalid PI_THINKING throws and lists valid levels", () => {
    process.env.PI_THINKING = "bogus";
    try {
      resolveLLM({});
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Invalid PI_THINKING "bogus"/);
      expect(msg).toContain("off");
      expect(msg).toContain("xhigh");
    }
  });

  test("PI_THINKING is case-sensitive (uppercase throws)", () => {
    process.env.PI_THINKING = "High";
    expect(() => resolveLLM({})).toThrow(/Invalid PI_THINKING "High"/);
  });

  test("unset PI_THINKING → built-in default (high), no throw", () => {
    expect(resolveLLM({}).thinkingLevel).toBe("high");
  });

  test("valid PI_THINKING is accepted", () => {
    process.env.PI_THINKING = "xhigh";
    expect(resolveLLM({}).thinkingLevel).toBe("xhigh");
  });

  test("explicit --thinking beats a valid PI_THINKING (precedence unaffected)", () => {
    process.env.PI_THINKING = "high";
    expect(resolveLLM({ thinking: "low" }).thinkingLevel).toBe("low");
  });
});

// --- resolveModel + allModels with a fake registry ---------------------------

function fakeRegistry(all: any[], available: any[] = all) {
  return {
    find: (provider: string, id: string) =>
      all.find(
        (m) => m.provider === provider && m.id === id,
      ),
    getAll: () => all,
    getAvailable: () => available,
  };
}

describe("allModels", () => {
  test("prefers getAll() when present", () => {
    const reg = fakeRegistry([{ id: "a" }, { id: "b" }], [{ id: "a" }]);
    expect(allModels(reg)).toHaveLength(2);
  });

  test("falls back to getAvailable() when getAll is not a function", () => {
    const reg = {
      find: () => undefined,
      getAvailable: () => [{ id: "only-available" }],
    };
    expect(allModels(reg)).toEqual([{ id: "only-available" }]);
  });
});

describe("resolveModel", () => {
  const models = [
    { provider: "anthropic", id: "claude-opus-4", name: "Opus" },
    { provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet" },
    { provider: "openai", id: "gpt-4o", name: "GPT 4o" },
  ];

  test("exact provider+id match wins", () => {
    const m = resolveModel(
      { modelRegistry: fakeRegistry(models) } as any,
      "anthropic",
      "claude-opus-4",
    );
    expect(m.id).toBe("claude-opus-4");
  });

  test("falls back to a case-insensitive provider+id substring match", () => {
    const m = resolveModel(
      { modelRegistry: fakeRegistry(models) } as any,
      "anthropic",
      "sonnet",
    );
    expect(m.id).toBe("claude-sonnet-5");
  });

  test("falls back to an any-provider id substring match", () => {
    const m = resolveModel(
      { modelRegistry: fakeRegistry(models) } as any,
      "zai",
      "gpt-4o",
    );
    expect(m.id).toBe("gpt-4o");
    expect(m.provider).toBe("openai");
  });

  test("matches on the display name too", () => {
    const m = resolveModel(
      { modelRegistry: fakeRegistry(models) } as any,
      "anything",
      "opus",
    );
    expect(m.id).toBe("claude-opus-4");
  });

  test("no match → throws naming the provider/id and listing available", () => {
    expect(() =>
      resolveModel(
        { modelRegistry: fakeRegistry(models) } as any,
        "zai",
        "nonexistent",
      ),
    ).toThrow(/Model "zai\/nonexistent" not found/);
  });
});
