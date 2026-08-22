import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  PROVIDERS,
  resolveApiKey,
  registerAllProviders,
  BUILTIN_MODEL_DEFAULT,
  DEFAULT_MODELS_STORE,
  buildModelsStoreJson,
  shouldEnsureModelsStore,
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

// ─── §4 DEFAULT_MODELS_STORE + seed helpers ───────────────────────────────────

describe("DEFAULT_MODELS_STORE — the curated provider catalog", () => {
  test("covers the providers the built-in defaults resolve against", () => {
    // zai hosts the built-in default model; deepseek hosts the obsidian
    // subagent floor (BUILTIN_MODEL_DEFAULT §2).
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
