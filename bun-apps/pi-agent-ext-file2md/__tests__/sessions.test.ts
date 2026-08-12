/**
 * resolveLLM model-id grammar + env-fallback guard.
 *
 * resolveLLM is the pure parser that turns opts/env into a {provider, modelId,
 * thinkingLevel}. It is the piece of src/sessions.ts that had drifted from
 * `pi-agent cli` (it used to ignore PI_PROVIDER). These tests pin the grammar
 * so the drift cannot silently return.
 *
 * No model session / network is created — resolveLLM is pure.
 *
 *   bun test __tests__/sessions.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveLLM } from "../src/sessions.ts";

// resolveLLM reads PI_MODEL / PI_PROVIDER / PI_THINKING at call time. Snapshot
// the relevant env, restore after each test so order doesn't matter.
const KEYS = ["PI_MODEL", "PI_PROVIDER", "PI_THINKING"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveLLM — no-config contract (ticket 01)", () => {
  test("no opts, no env → throws (no hardcoded default; /models-preset pointer)", () => {
    expect(() => resolveLLM({})).toThrow(/No model configured/);
  });
});

describe("resolveLLM — env fallbacks", () => {
  test("PI_MODEL overrides the default model id", () => {
    process.env.PI_MODEL = "foo/bar-model";
    const r = resolveLLM({});
    expect(r.provider).toBe("foo");
    expect(r.modelId).toBe("bar-model");
  });

  test("PI_PROVIDER overrides the default provider (when model has no slash)", () => {
    // The default model "lm-studio/..." has a slash and would re-set provider,
    // so to observe PI_PROVIDER alone we pair it with a slash-less PI_MODEL.
    process.env.PI_PROVIDER = "anthropic";
    process.env.PI_MODEL = "claude-vision";
    const r = resolveLLM({});
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude-vision");
  });

  test("PI_THINKING sets the thinking level", () => {
    process.env.PI_MODEL = "x/y"; // a model is required (ticket 01: no default)
    process.env.PI_THINKING = "high";
    const r = resolveLLM({});
    expect(r.thinkingLevel).toBe("high");
  });
});

describe("resolveLLM — explicit opts beat env", () => {
  test("opts.model beats PI_MODEL", () => {
    process.env.PI_MODEL = "env/model";
    const r = resolveLLM({ model: "opt/other" });
    expect(r.provider).toBe("opt");
    expect(r.modelId).toBe("other");
  });

  test("opts.provider beats PI_PROVIDER", () => {
    process.env.PI_PROVIDER = "anthropic";
    process.env.PI_MODEL = "slashless";
    const r = resolveLLM({ provider: "zai" });
    expect(r.provider).toBe("zai");
    expect(r.modelId).toBe("slashless");
  });
});

describe("resolveLLM — provider/modelId:thinking shorthand", () => {
  test("opts.model 'provider/id' splits on the first slash", () => {
    const r = resolveLLM({ model: "anthropic/claude-x" });
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude-x");
  });

  test("model shorthand overrides PI_PROVIDER", () => {
    process.env.PI_PROVIDER = "anthropic";
    const r = resolveLLM({ model: "lm-studio/qwen-vl" });
    expect(r.provider).toBe("lm-studio");
    expect(r.modelId).toBe("qwen-vl");
  });

  test("':thinking' suffix is stripped and sets the level", () => {
    const r = resolveLLM({ model: "x/y:high" });
    expect(r.provider).toBe("x");
    expect(r.modelId).toBe("y");
    expect(r.thinkingLevel).toBe("high");
  });

  test("unknown ':token' suffix is NOT parsed as thinking (modelId keeps it)", () => {
    const r = resolveLLM({ model: "foo/bar:notalevel" });
    expect(r.provider).toBe("foo");
    expect(r.modelId).toBe("bar:notalevel");
    expect(r.thinkingLevel).toBe("off");
  });

  test("colon before the slash is not treated as a thinking separator", () => {
    // "weird:thing/x" — colon(5) is NOT after firstSlash(11), so no parse.
    const r = resolveLLM({ model: "weird:thing/x" });
    expect(r.provider).toBe("weird:thing");
    expect(r.modelId).toBe("x");
  });
});

describe("resolveLLM — opts.thinking wins", () => {
  test("explicit opts.thinking beats the ':suffix'", () => {
    const r = resolveLLM({ model: "x/y:high", thinking: "low" });
    expect(r.thinkingLevel).toBe("low");
  });

  test("explicit opts.thinking beats PI_THINKING env", () => {
    process.env.PI_MODEL = "x/y"; // a model is required (ticket 01: no default)
    process.env.PI_THINKING = "high";
    const r = resolveLLM({ thinking: "medium" });
    expect(r.thinkingLevel).toBe("medium");
  });

  test("unknown opts.thinking value is ignored (no crash)", () => {
    process.env.PI_MODEL = "x/y"; // a model is required (ticket 01: no default)
    const r = resolveLLM({ thinking: "bogus" as unknown as string });
    expect(r.thinkingLevel).toBe("off");
  });
});
