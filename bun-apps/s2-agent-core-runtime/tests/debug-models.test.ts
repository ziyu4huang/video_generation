/**
 * PI_DEBUG_MODELS — the one env knob that surfaces EVERY model-id decision:
 * which tier was requested, which branch won (explicit model / capability /
 * tier / default-medium / session default), whether scope clamped it, where
 * the model-tiers config was read from, and how the vision capability
 * resolved. Read at call time (plain process.env), so it works identically in
 * source runs and inside the compiled sh deploy binary.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScopedAgentModelSpec } from "../src/agent-model.js";
import { debugModelsEnabled, logModelDecision } from "../src/debug-models.js";
import { loadModelTierConfig } from "../src/model-role-config.js";

function captureConsoleError<T>(fn: () => T): { lines: string[]; ret: T } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const ret = fn();
    return { lines, ret };
  } finally {
    console.error = orig;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.PI_DEBUG_MODELS;
});

describe("debugModelsEnabled", () => {
  test("1 and true enable; anything else does not", () => {
    expect(debugModelsEnabled({ PI_DEBUG_MODELS: "1" } as Record<string, string>)).toBe(true);
    expect(debugModelsEnabled({ PI_DEBUG_MODELS: "true" } as Record<string, string>)).toBe(true);
    expect(debugModelsEnabled({ PI_DEBUG_MODELS: "0" } as Record<string, string>)).toBe(false);
    expect(debugModelsEnabled({} as Record<string, string>)).toBe(false);
  });
});

describe("logModelDecision", () => {
  test("silent unless PI_DEBUG_MODELS is set", () => {
    const { lines } = captureConsoleError(() => logModelDecision("test", { a: 1 }));
    expect(lines).toEqual([]);
  });

  test("emits a [models] line with the where-tag and field=value pairs", () => {
    process.env.PI_DEBUG_MODELS = "1";
    const { lines } = captureConsoleError(() => logModelDecision("resolve", { tier: "small", spec: "zai/glm-4.7" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[models] resolve");
    expect(lines[0]).toContain("tier=");
    expect(lines[0]).toContain("small");
    expect(lines[0]).toContain("zai/glm-4.7");
  });
});

describe("decision-point logging", () => {
  test("loadModelTierConfig names the config path and what it found", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-models-"));
    dirs.push(dir);
    const cfgPath = join(dir, "model-tiers.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
        capabilities: { vision: "lm-studio/google/gemma-4-12b" },
      }),
    );
    process.env.PI_DEBUG_MODELS = "1";
    const { lines, ret } = captureConsoleError(() => loadModelTierConfig(cfgPath));
    expect(ret?.capabilities?.vision).toBe("lm-studio/google/gemma-4-12b");
    expect(lines.some((l) => l.includes("[models] load-config") && l.includes(cfgPath))).toBe(true);
    expect(lines.some((l) => l.includes("vision") && l.includes("gemma-4-12b"))).toBe(true);
  });

  test("absent config is reported as absent, not silent", () => {
    process.env.PI_DEBUG_MODELS = "1";
    const { lines, ret } = captureConsoleError(() =>
      loadModelTierConfig(join(tmpdir(), "definitely-absent-model-tiers.json")),
    );
    expect(ret).toBeNull();
    expect(lines.some((l) => l.includes("absent"))).toBe(true);
  });

  test("resolveScopedAgentModelSpec explains which branch won and clamping", () => {
    process.env.PI_DEBUG_MODELS = "1";
    const loadConfig = () => ({
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    });
    const { lines, ret } = captureConsoleError(() =>
      resolveScopedAgentModelSpec({ tier: "small" }, "zai/glm-5.3", undefined, loadConfig),
    );
    expect(ret.spec).toBe("zai/glm-4.7");
    // One line names the winning branch (tier small → its configured model)…
    expect(lines.some((l) => l.includes("tier") && l.includes("zai/glm-4.7"))).toBe(true);
    // …and the untagged/default paths log too.
    const { lines: lines2 } = captureConsoleError(() =>
      resolveScopedAgentModelSpec({}, "zai/glm-5.3", undefined, loadConfig),
    );
    expect(lines2.some((l) => l.includes("default-medium") && l.includes("zai/glm-5.3"))).toBe(true);
    // Out-of-scope requests log the clamp with both specs.
    const { lines: lines3, ret: ret3 } = captureConsoleError(() =>
      resolveScopedAgentModelSpec({ tier: "small" }, "zai/glm-5.3", ["zai/glm-5.3"], loadConfig),
    );
    expect(ret3.clamped).toBe(true);
    expect(lines3.some((l) => l.includes("clamp") && l.includes("zai/glm-4.7") && l.includes("zai/glm-5.3"))).toBe(
      true,
    );
  });
});
