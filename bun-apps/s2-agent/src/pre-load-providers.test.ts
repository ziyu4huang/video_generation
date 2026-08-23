import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  PROVIDERS,
  resolveApiKey,
  registerAllProviders,
  BUILTIN_MODEL_DEFAULT,
  DEFAULT_MODEL_TIER_CONFIG,
} from "./pre-load-providers.ts";

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

  test("lm-studio registers a non-reasoning VLM sibling pre-wire (ticket 02)", () => {
    // `reasoning:false` is host metadata (pi treats it as non-reasoning); it does
    // NOT stop the LM Studio MLX server burning reasoning (which ignores client
    // thinking knobs). The sibling is the SELECTION target for capabilities.vision
    // once a genuinely no-thinking vision model is loaded under that id — until
    // then the working always-on-reasoning qwen stays the default. Catalog-only.
    const lm = PROVIDERS["lm-studio"];
    const siblings = lm.models.filter((m) => m.input.includes("image"));
    expect(siblings.length).toBeGreaterThanOrEqual(3);
    const nothink = siblings.find((m) => m.reasoning === false);
    expect(nothink).toBeDefined();
    expect(nothink!.id).toBe("qwen/qwen3.8-27b-nothink");
    expect(nothink!.input).toEqual(expect.arrayContaining(["image"]));
    // At least one always-on-reasoning multimodal default remains, so the
    // working vision path is not unregistered by the sibling addition.
    const anyReasoning = siblings.some((m) => m.reasoning === true);
    expect(anyReasoning).toBe(true);
  });

  test("capabilities.vision keeps the working reasoning default until the non-reasoning VLM is loaded", () => {
    expect(DEFAULT_MODEL_TIER_CONFIG.capabilities.vision).toBe("lm-studio/qwen/qwen3.8-27b");
    // The catalog sibling is present and non-reasoning, but the default does NOT
    // point at it (that id is not a loadable server model yet — the server 400s
    // an unknown model-id).
    const nothink = PROVIDERS["lm-studio"].models.find((m) => m.reasoning === false);
    expect(nothink).toBeDefined();
    expect(DEFAULT_MODEL_TIER_CONFIG.capabilities.vision).not.toContain(nothink!.id);
  });

  test("deepseek re-lists the baked family — extension registration REPLACES it", () => {
    // registerProvider("deepseek", ...) replaces the pi-ai baked catalog list
    // (applyExtension → config.models.map), so every model the runtime must
    // keep — incl. the ones baked upstream (v4-flash, v4-pro) and referenced
    // elsewhere (obsidianSubagentFloor "deepseek/deepseek-v4-flash") — must be
    // enumerated HERE. Omitting one silently drops it from --list-models.
    const ds = PROVIDERS["deepseek"];
    expect(ds).toBeDefined();
    const ids = ds.models.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]),
    );
    const vision = ds.models.find((m) => m.id === "deepseek-v4-flash-vision-exp");
    expect(vision).toBeDefined();
    expect(vision!.input).toContain("image");
    expect(vision!.reasoning).toBe(true);
    // OpenAI-style endpoint rejects the "[1m]" alias (400, measured 2026-08-23)
    // — the plain id is the only registerable name on this provider.
  });
});

describe("module purity (no ModelRuntime side effects)", () => {
  test("importing pre-load-providers.ts does not patch ModelRuntime.create", () => {
    const fixture = join(import.meta.dir, "__tests__", "fixtures", "check-pre-load-providers-pure.ts");
    // process.execPath (not the literal "bun") — spawns the running runtime
    // itself, always present on CI (portability P2, see .github/TEST-PORTABILITY.md).
    const proc = spawnSync(process.execPath, [fixture], { encoding: "utf8", cwd: import.meta.dir });
    expect(proc.status).toBe(0);
    const result = JSON.parse(proc.stdout.trim());
    expect(result.unchanged).toBe(true);
  });
});

describe("registerAllProviders", () => {
  test("calls registerProvider exactly once per PROVIDERS entry", () => {
    const calls: Array<[string, unknown]> = [];
    const fakeRegistry = { registerProvider: (name: string, config: unknown) => calls.push([name, config]) };
    registerAllProviders(fakeRegistry, {});
    expect(calls.length).toBe(Object.keys(PROVIDERS).length);
    expect(calls.map(([name]) => name).sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  test("resolves apiKey and zeroes cost for every registered model", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: Array<[string, any]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRegistry = { registerProvider: (name: string, config: any) => calls.push([name, config]) };
    registerAllProviders(fakeRegistry, {});
    for (const [, config] of calls) {
      expect(typeof config.apiKey).toBe("string");
      for (const m of config.models) {
        expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      }
    }
  });
});

// ─── §2 BUILTIN_MODEL_DEFAULT ─────────────────────────────────────────────────

describe("BUILTIN_MODEL_DEFAULT", () => {
  test("provider/model match the repo standard (zai/glm-5.3)", () => {
    expect(BUILTIN_MODEL_DEFAULT.provider).toBe("zai");
    expect(BUILTIN_MODEL_DEFAULT.model).toBe("glm-5.3");
  });

  test("thinking is a valid pi-agent-core ThinkingLevel", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
    expect(levels).toContain(BUILTIN_MODEL_DEFAULT.thinking);
  });

  test("obsidian floor is provider-qualified (usable as OB_SUBAGENT_MODEL)", () => {
    expect(BUILTIN_MODEL_DEFAULT.obsidianSubagentFloor).toMatch(/^[^/]+\/.+$/);
  });
});
