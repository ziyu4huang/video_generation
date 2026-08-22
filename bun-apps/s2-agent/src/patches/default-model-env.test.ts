/**
 * default-model-env — unit tests for resolveEnvBridges (pure decision logic).
 *
 * The import-time side effect (process.argv.splice) is intentionally NOT
 * tested here; it is a thin wrapper around the pure function below. Mirrors
 * the resolvePatchPlan split in index.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { resolveEnvBridges, BRIDGES } from "./default-model-env.ts";

const E = (entries: Record<string, string>) => entries;

describe("resolveEnvBridges — env → argv bridging", () => {
  test("no env set → nothing spliced", () => {
    expect(resolveEnvBridges(["-p", "hi"], {})).toEqual([]);
  });

  test("PI_MODEL set + no --model in argv → splices --model <val>", () => {
    expect(
      resolveEnvBridges(["-p", "hi"], E({ PI_MODEL: "zai/glm-5.3" })),
    ).toEqual(["--model", "zai/glm-5.3"]);
  });

  test("PI_PROVIDER set + no --provider → splices --provider", () => {
    expect(
      resolveEnvBridges([], E({ PI_PROVIDER: "lm-studio" })),
    ).toEqual(["--provider", "lm-studio"]);
  });

  test("PI_THINKING set + no --thinking → splices --thinking", () => {
    expect(
      resolveEnvBridges([], E({ PI_THINKING: "high" })),
    ).toEqual(["--thinking", "high"]);
  });

  test("all three set → --model suppresses --provider (model governs routing); thinking still spliced", () => {
    const out = resolveEnvBridges(
      [],
      E({ PI_MODEL: "m", PI_PROVIDER: "p", PI_THINKING: "t" }),
    );
    expect(out).toEqual(["--model", "m", "--thinking", "t"]);
  });

  test("provider/id:thinking shorthand passes through untouched (pi parses it)", () => {
    expect(
      resolveEnvBridges([], E({ PI_MODEL: "zai/glm-5.3:high" })),
    ).toEqual(["--model", "zai/glm-5.3:high"]);
  });
});

describe("resolveEnvBridges — explicit flag wins (no double-splice)", () => {
  test("space form `--model x` present → PI_MODEL NOT spliced", () => {
    expect(
      resolveEnvBridges(["--model", "explicit"], E({ PI_MODEL: "env-val" })),
    ).toEqual([]);
  });

  test("= form `--model=x` present → PI_MODEL NOT spliced", () => {
    expect(
      resolveEnvBridges(["--model=explicit"], E({ PI_MODEL: "env-val" })),
    ).toEqual([]);
  });

  test("--model present → PI_PROVIDER suppressed (model governs routing); PI_THINKING still splices", () => {
    expect(
      resolveEnvBridges(
        ["--model", "x"],
        E({ PI_MODEL: "m", PI_PROVIDER: "p", PI_THINKING: "t" }),
      ),
    ).toEqual(["--thinking", "t"]);
  });

  test("prefix-similarity is safe (--mode does NOT suppress --model)", () => {
    // "--mode" startsWith "--mode" but must not be mistaken for "--model".
    expect(
      resolveEnvBridges(["--mode", "json"], E({ PI_MODEL: "m" })),
    ).toEqual(["--model", "m"]);
  });

  test("a set-but-empty env var is skipped (treat as unset)", () => {
    // PI_MODEL="" → falsy → not spliced (no empty --model).
    expect(resolveEnvBridges([], E({ PI_MODEL: "" }))).toEqual([]);
  });
});

describe("resolveEnvBridges — purity + injection-shape", () => {
  test("does not read process.env when env passed explicitly", () => {
    process.env.__bridgeProbe = "leak";
    try {
      const probes = [{ env: "__bridgeProbe", flag: "--probe" }];
      expect(resolveEnvBridges([], {}, probes)).toEqual([]);
      expect(resolveEnvBridges([], process.env, probes)).toEqual([
        "--probe",
        "leak",
      ]);
    } finally {
      delete process.env.__bridgeProbe;
    }
  });

  test("BRIDGES covers exactly model/provider/thinking", () => {
    expect(BRIDGES.map((b) => b.env)).toEqual([
      "PI_MODEL",
      "PI_PROVIDER",
      "PI_THINKING",
    ]);
    expect(BRIDGES.map((b) => b.flag)).toEqual([
      "--model",
      "--provider",
      "--thinking",
    ]);
  });

  test("output is always even-length flag/value pairs", () => {
    const out = resolveEnvBridges(
      [],
      E({ PI_MODEL: "m", PI_PROVIDER: "p", PI_THINKING: "t" }),
    );
    expect(out.length % 2).toBe(0);
  });
});

describe("resolveEnvBridges — built-in fill-gaps defaults", () => {
  const BUILTIN = {
    "--model": "glm-5.3",
    "--provider": "zai",
    "--thinking": "high",
  };

  test("no flag, no env, no personal settings → splices --model + --thinking (model suppresses provider)", () => {
    expect(
      resolveEnvBridges(["-p", "hi"], {}, BRIDGES, {
        settings: {},
        builtinByFlag: BUILTIN,
      }),
    ).toEqual(["--model", "glm-5.3", "--thinking", "high"]);
  });

  test("settings absent entirely (undefined) → --model + --thinking built-ins splice", () => {
    expect(
      resolveEnvBridges([], {}, BRIDGES, { builtinByFlag: BUILTIN }),
    ).toEqual(["--model", "glm-5.3", "--thinking", "high"]);
  });

  test("personal settings defaults WIN over built-ins (fill-gaps, never override)", () => {
    expect(
      resolveEnvBridges(
        [],
        {},
        BRIDGES,
        {
          settings: {
            defaultProvider: "lm-studio",
            defaultModel: "google/gemma-4-12b",
            defaultThinkingLevel: "low",
          },
          builtinByFlag: BUILTIN,
        },
      ),
    ).toEqual([]);
  });

  test("per-flag independence: personal defaultModel present → only its bridge suppressed", () => {
    expect(
      resolveEnvBridges([], {}, BRIDGES, {
        settings: { defaultModel: "glm-4.7" },
        builtinByFlag: BUILTIN,
      }),
    ).toEqual(["--provider", "zai", "--thinking", "high"]);
  });

  test("env still wins over BOTH settings and built-in", () => {
    expect(
      resolveEnvBridges([], E({ PI_MODEL: "env-m" }), BRIDGES, {
        settings: { defaultModel: "settings-m" },
        builtinByFlag: BUILTIN,
      }),
    ).toEqual(["--model", "env-m", "--thinking", "high"]);
  });

  test("explicit flag beats everything (built-in not double-spliced)", () => {
    expect(
      resolveEnvBridges(["--model", "x"], {}, BRIDGES, {
        builtinByFlag: BUILTIN,
      }),
    ).toEqual(["--thinking", "high"]);
  });

  test("blank-string personal default is treated as absent (built-in fills)", () => {
    expect(
      resolveEnvBridges([], {}, BRIDGES, {
        settings: { defaultModel: "   " },
        builtinByFlag: BUILTIN,
      }),
    ).toEqual(["--model", "glm-5.3", "--thinking", "high"]);
  });

  test("no builtinByFlag passed → legacy behavior (nothing spliced without env)", () => {
    // Backward-compat: callers that don't opt into built-ins see the old
    // env-only bridge semantics.
    expect(resolveEnvBridges(["-p", "hi"], {})).toEqual([]);
  });
});

describe("resolveEnvBridges — --model governs provider routing", () => {
  // Incident 2026-08-22 (deployed 0.1.1+g89ee4d8): `--model lm-studio/qwen/qwen3.8-27b`
  // 400'd against zai. The pi harness exports PI_PROVIDER=zai to every child
  // process, so the bridge spliced `--provider zai` alongside the user's --model;
  // upstream resolveCliModel then skips slash-inference, misses the id in the zai
  // catalog, and buildFallbackModel fabricates a bogus zai model id → zai 400.
  // Fix: whenever a --model token will exist in the final argv (user flag, `=`
  // form, or a PI_MODEL/bridge-spliced one), the --provider bridge stays silent.

  const BUILTIN = {
    "--model": "glm-5.3",
    "--provider": "zai",
    "--thinking": "high",
  };

  test("user --model provider/model + PI_PROVIDER env → NO --provider splice (incident)", () => {
    expect(
      resolveEnvBridges(
        ["--model", "lm-studio/qwen/qwen3.8-27b", "-p", "hi"],
        E({ PI_PROVIDER: "zai" }),
      ),
    ).toEqual([]);
  });

  test("user --model provider/model + built-in defaults → only --thinking splices", () => {
    expect(
      resolveEnvBridges(
        ["--model", "lm-studio/qwen/qwen3.8-27b"],
        {},
        BRIDGES,
        { settings: {}, builtinByFlag: BUILTIN },
      ),
    ).toEqual(["--thinking", "high"]);
  });

  test("PI_MODEL provider/model + PI_PROVIDER env → only --model splices", () => {
    expect(
      resolveEnvBridges(
        [],
        E({ PI_MODEL: "lm-studio/qwen/qwen3.8-27b", PI_PROVIDER: "zai" }),
      ),
    ).toEqual(["--model", "lm-studio/qwen/qwen3.8-27b"]);
  });

  test("= form --model=x also suppresses the --provider bridge", () => {
    expect(
      resolveEnvBridges(["--model=lm-studio/x"], E({ PI_PROVIDER: "zai" })),
    ).toEqual([]);
  });

  test("--thinking is never suppressed by model routing", () => {
    expect(
      resolveEnvBridges(
        ["--model", "lm-studio/x"],
        E({ PI_THINKING: "low" }),
      ),
    ).toEqual(["--thinking", "low"]);
  });

  test("explicit user --provider flag still wins over everything", () => {
    // A typed --provider must never be dropped — only INJECTED ones are.
    expect(
      resolveEnvBridges(
        ["--model", "x", "--provider", "deepseek"],
        E({ PI_PROVIDER: "zai" }),
      ),
    ).toEqual([]);
  });
});
