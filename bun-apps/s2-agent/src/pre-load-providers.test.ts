import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDERS,
  resolveApiKey,
  registerAllProviders,
  bakedProviderConfigs,
  BUILTIN_MODEL_DEFAULT,
  DEFAULT_MODEL_TIER_CONFIG,
  EMBEDDING_CONFIG,
} from "./pre-load-providers.ts";
import { SEMANTIC_MODEL_DEFAULT } from "@repo/s2-agent-core-interface";
// Baked upstream catalog — the source our REPLACE-semantics re-listing must
// keep covering (pi-ai subpath export; JSON-backed, regenerates on upgrade).
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";

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

  test("lm-studio vision models carry the reasoning_effort no-think wiring", () => {
    // The ONE server-honored disable knob is top-level `reasoning_effort:"none"`
    // (measured 2026-08-24 on both gemma-4-12b and qwen3.8-27b — study note
    // above LM_STUDIO_COMPAT in the source). The pi-ai adapter only emits it
    // when compat.supportsReasoningEffort is true (the provider level pins it
    // FALSE), and with thinking off the adapter sends thinkingLevelMap.off —
    // so every vision-capable lm-studio model must carry both. Every mapped
    // value must be a WIRE-valid enum member (the server 400s 'on'/'off').
    const WIRE_ENUM = ["none", "minimal", "low", "medium", "high", "xhigh"];
    const lm = PROVIDERS["lm-studio"];
    const vision = lm.models.filter((m) => m.input.includes("image"));
    expect(vision.length).toBeGreaterThanOrEqual(2);
    for (const m of vision) {
      expect(m.compat?.supportsReasoningEffort).toBe(true);
      expect(m.thinkingLevelMap?.off).toBe("none");
      expect(m.thinkingLevelMap?.minimal).toBe("none");
      for (const v of Object.values(m.thinkingLevelMap ?? {})) {
        // null = "level unsupported" — legal per the ModelEntry type, but not
        // what these entries use; every mapped value must be a wire-valid string.
        expect(typeof v).toBe("string");
        expect(WIRE_ENUM).toContain(v as string);
      }
    }
    // qwen speaks xhigh natively; `high` warns and falls back to on.
    const qwen = lm.models.find((m) => m.id === "qwen/qwen3.8-27b");
    expect(qwen?.thinkingLevelMap?.high).toBe("xhigh");
  });

  test("capabilities.vision = prism-ml/bonsai-27b with the :off no-think pin", () => {
    // The vision lane moved gemma-4-12b → bonsai-27b (user directive
    // 2026-08-24, quality over speed — gemma is ~5× faster per image call
    // measured; see the §3 comment in the source). The `:off` spec suffix is
    // what makes every vision call resolve thinking-off (the map then emits
    // reasoning_effort:"none").
    expect(DEFAULT_MODEL_TIER_CONFIG.capabilities.vision).toBe("lm-studio/prism-ml/bonsai-27b:off");
    for (const key of ["vision-large", "vision-medium", "vision-small"]) {
      expect(DEFAULT_MODEL_TIER_CONFIG.capabilities[key]).toBe(
        "lm-studio/prism-ml/bonsai-27b:off",
      );
    }
    // The catalog id the spec selects must exist (strip the provider + :thinking).
    const id = "prism-ml/bonsai-27b";
    const entry = PROVIDERS["lm-studio"].models.find((m) => m.id === id);
    expect(entry).toBeDefined();
    expect(entry!.input).toContain("image");
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

  test("zai re-lists every baked model + adds glm-5.3-flash with vision", () => {
    // Same REPLACE semantics as deepseek: registering "zai" swaps the
    // provider model list wholesale — every baked entry (glm-4.7, glm-5-turbo,
    // glm-5.2, glm-5.2-highspeed, glm-5.3) plus the tier-config refs
    // (zai/glm-5.3-flash small, zai/glm-5.3 medium/big) must survive. glm-5.3-flash
    // (added 2026-08-27, mirrors claude-code-glm.sh AIR tier) is the vision
    // lane — verified with a real image call 2026-08-27 (solid-red 64x64 PNG
    // through the read tool answered "Red").
    const z = PROVIDERS["zai"];
    expect(z).toBeDefined();
    const ids = z.models.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(["glm-4.7", "glm-5-turbo", "glm-5.2", "glm-5.2-highspeed", "glm-5.3", "glm-5.3-flash"]),
    );
    const flash = z.models.find((m) => m.id === "glm-5.3-flash");
    expect(flash).toBeDefined();
    expect(flash!.input).toContain("image");
    expect(flash!.reasoning).toBe(true);
    expect(flash!.contextWindow).toBe(1_000_000);
    // The ONE baked zai entry with reasoning effort on keeps its per-model
    // opt-in (provider-level pins it off).
    const g52 = z.models.find((m) => m.id === "glm-5.2");
    expect(g52?.compat?.supportsReasoningEffort).toBe(true);
  });

  test("lm-studio re-lists every local lane — incl. referenced + benchmarked ids", () => {
    // Same REPLACE semantics as deepseek: registering "lm-studio" swaps the
    // provider's model list wholesale. This pins the complete set — the
    // capability-spec target (google/gemma-4-12b), the QAT lane, the fallback
    // vision lane (qwen3.8-27b), and the 256K-context ternary lane
    // (prism-ml/bonsai-27b, benchmarked 2026-08-24). Omitting one silently
    // drops it from --list-models.
    const lm = PROVIDERS["lm-studio"];
    expect(lm).toBeDefined();
    const ids = lm.models.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "google/gemma-4-12b",
        "google/gemma-4-12b-qat",
        "qwen/qwen3.8-27b",
        "prism-ml/bonsai-27b",
      ]),
    );
    // bonsai is the 256K-context lane: the entry advertises the model's full
    // window (native /api/v0/models measured loaded_context_length 262144).
    const bonsai = lm.models.find((m) => m.id === "prism-ml/bonsai-27b");
    expect(bonsai?.contextWindow).toBe(262_144);
    expect(bonsai?.input).toContain("image");
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
  test("bakedProviderConfigs (the __piBakedProviders seam payload) ≡ what registerAllProviders pushes", () => {
    // The seam consumers (core-runtime's subagent registry) register the
    // payload verbatim, so the builder and the direct mutation path MUST
    // produce identical configs — this equivalence is what lets the cli
    // namespace (no applyPatches, no ModelRuntime.create wrap) behave like
    // the patched TUI path.
    const calls: Array<[string, unknown]> = [];
    const fakeRegistry = { registerProvider: (name: string, config: unknown) => calls.push([name, config]) };
    registerAllProviders(fakeRegistry, {});
    const seam = bakedProviderConfigs({});
    expect(Object.keys(seam).sort()).toEqual(calls.map(([name]) => name).sort());
    for (const [name, config] of calls) {
      expect(seam[name]).toEqual(config as Record<string, unknown>);
    }
  });

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

// ─── §4 EMBEDDING_CONFIG ─────────────────────────────────────────────────────

describe("EMBEDDING_CONFIG", () => {
  test("no imports at all — every LLM setting is authored in this file", () => {
    // User directive 2026-08-24: pre-load-providers.ts is THE one place for
    // baked LLM config, importing nothing (the prior version imported
    // SEMANTIC_MODEL_DEFAULT from core-interface). Guard the contract so a
    // future import cannot silently creep back in — static imports, dynamic
    // import() calls, and require() are all tripped.
    const src = readFileSync(join(import.meta.dir, "pre-load-providers.ts"), "utf8");
    const imports = src.match(/^import\b.*$/gm) ?? [];
    expect(imports).toEqual([]);
    const dynamic = src.match(/\b(?:import|require)\s*\(/g) ?? [];
    expect(dynamic).toEqual([]);
  });

  test("model id is authored inline (bge-m3, D3) and drift-guarded vs core-interface's fallback", () => {
    // core-interface sits BELOW this package, so its SEMANTIC_MODEL_DEFAULT
    // is a host-absent FALLBACK only; the canonical id lives in §4. This
    // import direction (s2-agent → core-interface) is the legal one — the
    // test pins the two literals so they cannot drift apart.
    expect(EMBEDDING_CONFIG.model).toBe("text-embedding-bge-m3");
    expect(EMBEDDING_CONFIG.model).toBe(SEMANTIC_MODEL_DEFAULT);
  });

  test("base is DERIVED from the lm-studio PROVIDERS entry (no /v1, no second copy)", () => {
    expect(PROVIDERS["lm-studio"].baseUrl).toMatch(/\/v1$/);
    expect(EMBEDDING_CONFIG.base).toBe(PROVIDERS["lm-studio"].baseUrl.replace(/\/v1$/, ""));
    expect(EMBEDDING_CONFIG.base).not.toMatch(/\/v1$/);
  });
});

// ─── §zai folded-compat pin (2026-08-28, #2100 review follow-up) ─────────────
describe("zai folded compat — zaiToolStream is the non-inferred pin", () => {
	// The provider-level compat folds onto every model (bakedProviderConfigs);
	// pi-ai's adapter reads `compat.zaiToolStream ?? detected` where
	// detectCompat() hardcodes FALSE. A future cleanup trusting the "detectCompat
	// infers the same compat" comment would flip streaming off for the repo's
	// DEFAULT provider with zero red tests — this is that test.
	test("every zai model's FOLDED compat keeps zaiToolStream: true", () => {
		const seam = bakedProviderConfigs({});
		const zai = seam["zai"] as { models: Array<{ id: string; compat?: { zaiToolStream?: boolean } }> };
		expect(zai.models.length).toBeGreaterThanOrEqual(6); // 5 baked re-listed + glm-5.3-flash
		for (const m of zai.models) {
			expect(m.compat?.zaiToolStream, `zai/${m.id} lost zaiToolStream through the fold`).toBe(true);
		}
	});

	test("glm-5.2 keeps its per-model supportsReasoningEffort opt-in through the fold", () => {
		const seam = bakedProviderConfigs({});
		const zai = seam["zai"] as { models: Array<{ id: string; compat?: { supportsReasoningEffort?: boolean } }> };
		const glm52 = zai.models.find((m) => m.id === "glm-5.2");
		expect(glm52?.compat?.supportsReasoningEffort).toBe(true);
	});
});

// ─── §zai catalog drift guard (2026-08-28, #2100 review follow-up) ───────────
describe("zai catalog drift guard — REPLACE re-listing covers every baked model", () => {
	// Registering over the baked "zai" provider id REPLACES its model list
	// (pi-ai REPLACE semantics — see pre-load-providers.ts zai block). If a
	// pi-ai upgrade ships a new model (say glm-5.4) and our re-listing isn't
	// updated, the model silently vanishes from --list-models. This test
	// compares against the LIVE baked catalog, not a hardcoded id list, so it
	// reds the moment upstream adds a model we don't re-list.
	test("every baked pi-ai zai model id survives the re-listing", () => {
		const bakedIds = Object.keys(ZAI_MODELS);
		expect(bakedIds.length).toBeGreaterThanOrEqual(5); // sanity: catalog resolved
		const listedIds = new Set(
			(bakedProviderConfigs({})["zai"] as { models: Array<{ id: string }> }).models.map((m) => m.id),
		);
		const missing = bakedIds.filter((id) => !listedIds.has(id));
		expect(missing, `baked zai models dropped by the re-listing: ${missing.join(", ")}`).toEqual([]);
	});
});
