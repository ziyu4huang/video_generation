/**
 * /models-preset command — TRANSIENT session-switch contract.
 *
 * Pins ADR-subagent-0006: applying a preset switches the main model +
 * installs the in-memory tier override, and NEVER touches the filesystem —
 * the DI surface has no save/write dependency at all, so any regression back
 * to persisting ~/.pi/workflows/model-tiers.json has to ADD a dep (and show
 * up here as an untested side effect) rather than slip through silently.
 *
 * Uses DI (not mock.module) so the test does NOT leak a model-role-config mock
 * into sibling test files under bun's shared-realm default.
 */
import { describe, expect, test } from "bun:test";
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";
import { createModelsPresetCommand, parseModelSpec } from "../extensions/models-preset.js";
import { MODEL_PRESETS, mainModelSpec } from "../src/presets.js";

interface Harness {
  ctx: any;
  calls: {
    switchMainModel: string[];
    setTransientConfig: ModelTierConfig[];
    notify: { msg: string; level: string }[];
    select: { title: string; options: string[] }[];
  };
}

/** Build a handler with recorded side effects + a fake command context. */
function makeHarness(opts: { switchResult?: { ok: boolean; reason?: string }; select?: string | null } = {}) {
  const calls: Harness["calls"] = { switchMainModel: [], setTransientConfig: [], notify: [], select: [] };
  const handler = createModelsPresetCommand({} as any, {
    switchMainModel: async (spec) => {
      calls.switchMainModel.push(spec);
      return opts.switchResult ?? { ok: true };
    },
    setTransientConfig: (cfg) => {
      calls.setTransientConfig.push(cfg);
    },
  });
  const ctx = {
    ui: {
      confirm: async () => true, // must NEVER be called anymore — asserted below
      select: async (title: string, options: string[]) => {
        calls.select.push({ title, options });
        return opts.select ?? null;
      },
      notify: (msg: string, level: string) => calls.notify.push({ msg, level }),
    },
  };
  return { handler, ctx, calls };
}

describe("/models-preset — transient contract", () => {
  test("direct apply switches the main model + installs the tier override, no confirm", async () => {
    const { handler, ctx, calls } = makeHarness();
    await handler("glm", ctx);

    // Main model = the preset's headline (big) model.
    expect(calls.switchMainModel).toEqual(["zai/glm-5.3"]);
    // The FULL preset config (tiers + vision) goes to the transient override.
    expect(calls.setTransientConfig).toEqual([
      {
        tiers: { small: "zai/glm-5.3-flash", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
        capabilities: {
          vision: "zai/glm-5.3-flash",
          "vision-large": "zai/glm-5.3-flash",
          "vision-medium": "zai/glm-5.3-flash",
          "vision-small": "zai/glm-5.3-flash",
        },
      },
    ]);
    // Success notify says SESSION-only and that nothing is written.
    expect(calls.notify).toHaveLength(1);
    expect(calls.notify[0]?.level).toBe("info");
    expect(calls.notify[0]?.msg).toContain("GLM");
    expect(calls.notify[0]?.msg).toContain("THIS session only");
    expect(calls.notify[0]?.msg).toContain("nothing written to ~/.pi");
  });

  test("deepseek-pro preset switches to its headline (big) model", async () => {
    const { handler, ctx, calls } = makeHarness();
    await handler("deepseek-pro", ctx);
    expect(calls.switchMainModel).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(calls.setTransientConfig[0]?.tiers).toEqual({
      small: "lm-studio/prism-ml/bonsai-27b",
      medium: "deepseek/deepseek-v4-flash",
      big: "deepseek/deepseek-v4-pro",
    });
  });

  test("model switch failure → error notify, NO transient override installed", async () => {
    const { handler, ctx, calls } = makeHarness({
      switchResult: { ok: false, reason: "no API key configured for zai" },
    });
    await handler("glm", ctx);
    expect(calls.switchMainModel).toEqual(["zai/glm-5.3"]);
    expect(calls.setTransientConfig).toEqual([]);
    expect(calls.notify[0]?.level).toBe("error");
    expect(calls.notify[0]?.msg).toContain("no API key configured for zai");
  });

  test("unknown preset id notifies an error + lists available", async () => {
    const { handler, ctx, calls } = makeHarness();
    await handler("bogus", ctx);
    expect(calls.switchMainModel).toEqual([]);
    expect(calls.setTransientConfig).toEqual([]);
    expect(calls.notify[0]?.level).toBe("error");
    expect(calls.notify[0]?.msg).toContain("bogus");
    expect(calls.notify[0]?.msg).toContain("glm");
  });

  test("interactive picker applies the chosen preset", async () => {
    const { handler, ctx, calls } = makeHarness({ select: "deepseek-flash  —  tiers: …" });
    await handler("", ctx);
    expect(calls.select).toHaveLength(1);
    expect(calls.select[0]?.title).toContain("session");
    expect(calls.switchMainModel).toEqual(["deepseek/deepseek-v4-flash"]);
    expect(calls.setTransientConfig[0]?.tiers.big).toBe("deepseek/deepseek-v4-flash");
  });

  test("picker cancelled → nothing happens", async () => {
    const { handler, ctx, calls } = makeHarness({ select: null });
    await handler("", ctx);
    expect(calls.switchMainModel).toEqual([]);
    expect(calls.setTransientConfig).toEqual([]);
    expect(calls.notify).toEqual([]);
  });
});

describe("parseModelSpec", () => {
  test("provider/id split at the FIRST slash, optional :thinking suffix", () => {
    expect(parseModelSpec("zai/glm-5.3")).toEqual({ provider: "zai", modelId: "glm-5.3" });
    expect(parseModelSpec("lm-studio/prism-ml/bonsai-27b")).toEqual({
      provider: "lm-studio",
      modelId: "prism-ml/bonsai-27b",
    });
    expect(parseModelSpec("zai/glm-5.3:low")).toEqual({ provider: "zai", modelId: "glm-5.3", thinking: "low" });
    expect(parseModelSpec("no-slash")).toBeUndefined();
    expect(parseModelSpec("/leading")).toBeUndefined();
    expect(parseModelSpec("zai/")).toBeUndefined();
  });
});

describe("mainModelSpec — every preset has a headline model", () => {
  test("big tier is the switch target for every built-in preset", () => {
    expect(MODEL_PRESETS.length).toBeGreaterThanOrEqual(3);
    for (const p of MODEL_PRESETS) {
      const spec = mainModelSpec(p);
      expect(spec).toBeTruthy();
      expect(spec).toBe(p.config.tiers.big);
      expect(spec).toMatch(/^[a-z0-9.-]+\//i);
    }
  });
});
