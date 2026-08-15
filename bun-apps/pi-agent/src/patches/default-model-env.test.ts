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

  test("all three set → spliced in BRIDGES order (model, provider, thinking)", () => {
    const out = resolveEnvBridges(
      [],
      E({ PI_MODEL: "m", PI_PROVIDER: "p", PI_THINKING: "t" }),
    );
    expect(out).toEqual(["--model", "m", "--provider", "p", "--thinking", "t"]);
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

  test("--model present but PI_PROVIDER/PI_THINKING still splice", () => {
    expect(
      resolveEnvBridges(
        ["--model", "x"],
        E({ PI_MODEL: "m", PI_PROVIDER: "p", PI_THINKING: "t" }),
      ),
    ).toEqual(["--provider", "p", "--thinking", "t"]);
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
