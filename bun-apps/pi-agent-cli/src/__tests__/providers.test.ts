import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  buildModelRegistry,
  loadRepoLocalProviders,
  normalizeProviderEntry,
} from "../providers/index.ts";

/**
 * Tests for the layered provider registry:
 *   #1 GLOBAL models.json  (ModelRegistry.create)
 *   #2 REPO-LOCAL models.json (registerProvider)
 *   #3 BAKED-IN constant   (registerProvider, always last → always wins)
 *
 * Opt-out: PI_SKIP_MODELS_JSON=1 skips #1 and #2.
 */

const BAKED_BASE_URL = "http://localhost:1234/v1";

/** A models.json payload with lm-studio pointing at a BOGUS url. */
const bogusGlobal = {
  providers: {
    "lm-studio": {
      baseUrl: "http://BOGUS-GLOBAL:9999/v1",
      api: "openai-completions",
      apiKey: "global-key",
      models: [
        {
          id: "google/gemma-4-26b-a4b-qat",
          name: "Bogus Global",
          reasoning: false,
          input: ["text"],
          contextWindow: 4096,
          maxTokens: 512,
        },
      ],
    },
  },
};

/** A repo-local models.json that adds a UNIQUE provider + its own lm-studio. */
const repoLocal = {
  providers: {
    "lm-studio": {
      baseUrl: "http://BOGUS-REPO:8888/v1",
      api: "openai-completions",
      apiKey: "repo-key",
      models: [{ id: "repo-only-model", name: "Repo Only", reasoning: true }],
    },
    "repo-extra": {
      baseUrl: "http://repo-extra:1/v1",
      api: "openai-completions",
      apiKey: "extra-key",
      models: [{ id: "x1", name: "X1", reasoning: false }],
    },
  },
};

function tmpDir(prefix: string): string {
  return join(tmpdir(), `pi-reg-${prefix}-${process.pid}-${Date.now()}`);
}

function writeJson(dir: string, file: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, file);
  writeFileSync(p, JSON.stringify(data));
  return p;
}

const ENV_BACKUP: Record<string, string | undefined> = {};

beforeEach(() => {
  ENV_BACKUP.PI_SKIP_MODELS_JSON = process.env.PI_SKIP_MODELS_JSON;
  delete process.env.PI_SKIP_MODELS_JSON;
});

afterEach(() => {
  if (ENV_BACKUP.PI_SKIP_MODELS_JSON === undefined) {
    delete process.env.PI_SKIP_MODELS_JSON;
  } else {
    process.env.PI_SKIP_MODELS_JSON = ENV_BACKUP.PI_SKIP_MODELS_JSON;
  }
});

describe("buildModelRegistry — baked-in always overwrites", () => {
  test("baked lm-studio wins over a BOGUS global models.json (#3 > #1)", () => {
    const dir = tmpDir("global");
    const globalPath = writeJson(dir, "models.json", bogusGlobal);

    const { modelRegistry } = buildModelRegistry({
      authStorage: AuthStorage.inMemory(),
      globalModelsJsonPath: globalPath,
      // point repo-local at a non-existent path so only global + baked apply
      repoModelsJsonPath: join(dir, "nope.json"),
    });

    const m = modelRegistry.find("lm-studio", "google/gemma-4-26b-a4b-qat");
    expect(m).toBeDefined();
    // Baked baseUrl, NOT the bogus global one.
    expect(m!.baseUrl).toBe(BAKED_BASE_URL);
    // Baked model metadata (reasoning=true, image input), not global's.
    expect(m!.reasoning).toBe(true);
    expect(m!.input).toContain("image");
    // cost defaulted (global lacked it; baked normalizer fills zeros).
    expect(m!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    rmSync(dir, { recursive: true, force: true });
  });

  test("repo-local providers are loaded AND then overwritten by baked (#2 then #3)", () => {
    const gdir = tmpDir("g");
    const rdir = tmpDir("r");
    const globalPath = writeJson(gdir, "models.json", bogusGlobal);
    const repoPath = writeJson(rdir, "models.json", repoLocal);

    const { modelRegistry } = buildModelRegistry({
      authStorage: AuthStorage.inMemory(),
      globalModelsJsonPath: globalPath,
      repoModelsJsonPath: repoPath,
    });

    // #2 brought in a unique provider that baked does NOT touch → survives.
    const extra = modelRegistry.find("repo-extra", "x1");
    expect(extra).toBeDefined();
    expect(extra!.baseUrl).toBe("http://repo-extra:1/v1");

    // #3 overwrote lm-studio: baked baseUrl, and the repo-only model is GONE
    // (registerProvider fully replaces a provider's model list).
    const baked = modelRegistry.find("lm-studio", "google/gemma-4-26b-a4b-qat");
    expect(baked!.baseUrl).toBe(BAKED_BASE_URL);
    expect(modelRegistry.find("lm-studio", "repo-only-model")).toBeUndefined();

    rmSync(gdir, { recursive: true, force: true });
    rmSync(rdir, { recursive: true, force: true });
  });
});

describe("buildModelRegistry — opt-out (PI_SKIP_MODELS_JSON=1)", () => {
  test("skips both global and repo-local; only baked providers remain", () => {
    const gdir = tmpDir("skip-g");
    const rdir = tmpDir("skip-r");
    const globalPath = writeJson(gdir, "models.json", bogusGlobal);
    const repoPath = writeJson(rdir, "models.json", repoLocal);

    process.env.PI_SKIP_MODELS_JSON = "1";

    const { modelRegistry, selfContained } = buildModelRegistry({
      authStorage: AuthStorage.inMemory(),
      globalModelsJsonPath: globalPath,
      repoModelsJsonPath: repoPath,
    });

    expect(selfContained).toBe(true);

    // repo-only provider must NOT be present (repo-local was skipped).
    expect(modelRegistry.find("repo-extra", "x1")).toBeUndefined();

    // baked lm-studio still present and correct.
    const m = modelRegistry.find("lm-studio", "google/gemma-4-26b-a4b-qat");
    expect(m).toBeDefined();
    expect(m!.baseUrl).toBe(BAKED_BASE_URL);

    rmSync(gdir, { recursive: true, force: true });
    rmSync(rdir, { recursive: true, force: true });
  });

  test("opt-out also yields an in-memory AuthStorage when none provided", () => {
    process.env.PI_SKIP_MODELS_JSON = "1";
    const { authStorage } = buildModelRegistry();
    // inMemory auth storage has no file backend; just assert it resolves.
    expect(typeof authStorage.get).toBe("function");
  });
});

describe("buildModelRegistry — default (no opt-out, no explicit paths)", () => {
  test("returns a usable registry with baked lm-studio available", () => {
    // Don't pass global/repo paths → uses real ~/.pi/agent + real repo file.
    // We only assert the baked invariant, not whatever the host has configured.
    const { modelRegistry, selfContained } = buildModelRegistry({
      authStorage: AuthStorage.inMemory(),
    });
    expect(selfContained).toBe(false);
    const m = modelRegistry.find("lm-studio", "google/gemma-4-26b-a4b-qat");
    expect(m).toBeDefined();
    expect(m!.baseUrl).toBe(BAKED_BASE_URL);
    // hasConfiguredAuth must hold (baked apiKey is inline).
    expect(modelRegistry.hasConfiguredAuth(m!)).toBe(true);
  });
});

describe("normalizeProviderEntry — pi-compatible defaults", () => {
  test("fills cost/input/reasoning/name defaults like pi's parseModels", () => {
    const out = normalizeProviderEntry({
      baseUrl: "http://x/v1",
      api: "openai-completions",
      apiKey: "k",
      compat: { supportsDeveloperRole: false },
      models: [{ id: "bare-model" }],
    });
    const m = out.models![0]!;
    expect(m.name).toBe("bare-model");
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(["text"]);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // provider-level compat merged onto model.
    expect(m.compat).toMatchObject({ supportsDeveloperRole: false });
  });

  test("model-level compat overrides provider-level compat on clash", () => {
    const out = normalizeProviderEntry({
      baseUrl: "http://x/v1",
      api: "openai-completions",
      apiKey: "k",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [{ id: "m", compat: { supportsReasoningEffort: false } }],
    });
    expect(out.models![0]!.compat).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    });
  });
});

describe("loadRepoLocalProviders", () => {
  test("returns [] for a missing file (no throw)", () => {
    const out = loadRepoLocalProviders(join(tmpDir("none"), "absent.json"));
    expect(out).toEqual([]);
  });

  test("returns [] for an invalid JSON file (no throw)", () => {
    const dir = tmpDir("bad");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not valid json");
    expect(loadRepoLocalProviders(p)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads providers from a valid models.json", () => {
    const dir = tmpDir("ok");
    const p = writeJson(dir, "models.json", repoLocal);
    const out = loadRepoLocalProviders(p);
    expect(out.map((o) => o.providerName).sort()).toEqual(["lm-studio", "repo-extra"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Sanity: confirm ModelRegistry.inMemory really skips disk (built-in models
// only, no custom from any JSON). This guards against upstream behavior change.
describe("ModelRegistry.inMemory baseline", () => {
  test("does not load any custom provider from disk", () => {
    const reg = ModelRegistry.inMemory(AuthStorage.inMemory());
    const before = reg.getAll().length;
    expect(reg.find("repo-extra", "x1")).toBeUndefined();
    expect(reg.getAll().length).toBe(before);
  });
});

// Touch existsSync/ModelRegistry imports so they're not tree-shaken in some
// toolchains; harmless no-ops.
void existsSync;
void ModelRegistry;
