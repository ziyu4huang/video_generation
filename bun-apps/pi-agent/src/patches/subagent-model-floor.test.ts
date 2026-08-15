/**
 * subagent-model-floor — unit tests for resolveSubagentFloor (pure decision).
 *
 * The import-time side effect (process.env.OB_SUBAGENT_MODEL = …) is
 * intentionally NOT tested here; it is a thin wrapper around the pure function.
 * Mirrors the resolveEnvBridges / resolvePatchPlan split.
 */
import { describe, expect, test } from "bun:test";
import { resolveSubagentFloor } from "./subagent-model-floor.ts";

const S = (entries: Record<string, unknown>) => entries;
const E = (entries: Record<string, string | undefined>) => entries;

describe("resolveSubagentFloor — settings → floor", () => {
  test("obsidian.subagentModel set → returns it", () => {
    expect(
      resolveSubagentFloor(
        S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } }),
        {},
      ),
    ).toBe("deepseek/deepseek-v4-flash");
  });

  test("trims whitespace around the value", () => {
    expect(
      resolveSubagentFloor(
        S({ obsidian: { subagentModel: "  deepseek/deepseek-v4-flash  " } }),
        {},
      ),
    ).toBe("deepseek/deepseek-v4-flash");
  });

  test("provider/id:thinking shorthand passes through untouched", () => {
    expect(
      resolveSubagentFloor(
        S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash:high" } }),
        {},
      ),
    ).toBe("deepseek/deepseek-v4-flash:high");
  });
});

describe("resolveSubagentFloor — env override wins", () => {
  test("OB_SUBAGENT_MODEL already set → undefined (no clobber)", () => {
    expect(
      resolveSubagentFloor(
        S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } }),
        E({ OB_SUBAGENT_MODEL: "zai/glm-5.3" }),
      ),
    ).toBeUndefined();
  });

  test("env wins even when set to a 'weak'/flash model", () => {
    // The env is the per-session escape hatch; we never overwrite it.
    expect(
      resolveSubagentFloor(
        S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } }),
        E({ OB_SUBAGENT_MODEL: "lm-studio/google/gemma-4-12b-qat" }),
      ),
    ).toBeUndefined();
  });
});

describe("resolveSubagentFloor — no-op cases", () => {
  test("undefined settings → undefined", () => {
    expect(resolveSubagentFloor(undefined, {})).toBeUndefined();
  });

  test("missing obsidian.subagentModel field → undefined", () => {
    expect(
      resolveSubagentFloor(S({ defaultModel: "glm-5.3", subagents: {} }), {}),
    ).toBeUndefined();
  });

  test("non-string floor (number) → undefined", () => {
    expect(
      resolveSubagentFloor(S({ obsidian: { subagentModel: 123 } }), {}),
    ).toBeUndefined();
  });

  test("blank / whitespace-only floor → undefined", () => {
    expect(
      resolveSubagentFloor(S({ obsidian: { subagentModel: "   " } }), {}),
    ).toBeUndefined();
    expect(
      resolveSubagentFloor(S({ obsidian: { subagentModel: "" } }), {}),
    ).toBeUndefined();
  });
});

describe("resolveSubagentFloor — purity", () => {
  test("does not read process.env when env passed explicitly", () => {
    process.env.__floorProbe = "leak";
    try {
      // settings has the field, but env={} → should still return the floor
      // (proves it used the passed env, not process.env, for the override check).
      expect(
        resolveSubagentFloor(
          S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } }),
          {},
        ),
      ).toBe("deepseek/deepseek-v4-flash");
      // and if process.env HAS OB_SUBAGENT_MODEL, passing {} ignores it:
      process.env.OB_SUBAGENT_MODEL = "from-process-env";
      expect(
        resolveSubagentFloor(
          S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } }),
          {},
        ),
      ).toBe("deepseek/deepseek-v4-flash");
    } finally {
      delete process.env.__floorProbe;
      delete process.env.OB_SUBAGENT_MODEL;
    }
  });

  test("does not mutate the passed settings or env", () => {
    const settings = S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } });
    const env = E({ OB_SUBAGENT_MODEL: "x" });
    resolveSubagentFloor(settings, env);
    expect(settings).toEqual(S({ obsidian: { subagentModel: "deepseek/deepseek-v4-flash" } }));
    expect(env).toEqual(E({ OB_SUBAGENT_MODEL: "x" }));
  });
});
