/**
 * Self-contained provider registry for bun-pi-agent-cli.
 *
 * pi ( @earendil-works/pi-coding-agent ) only reads models.json from the
 * GLOBAL agent dir ( ~/.pi/agent/models.json ). It ignores repo-local
 * .pi/agent/models.json. This module bridges that gap AND bakes a curated set
 * of providers directly into the CLI so the compiled binary is self-contained.
 *
 * ## Layered resolution (last writer wins via registerProvider)
 *
 *   1. GLOBAL   ~/.pi/agent/models.json   — loaded natively by
 *      ModelRegistry.create(). Honors PI_CODING_AGENT_DIR like pi does.
 *   2. REPO     <repo>/.pi/agent/models.json — loaded by code via
 *      registerProvider. Overwrites #1 for the same provider. No-op if the
 *      file is absent. Overridable via PI_REPO_MODELS.
 *   3. BAKED    BAKED_IN_PROVIDERS (constant below) — ALWAYS registered last,
 *      so it unconditionally overwrites #1 and #2. This is what makes the
 *      compiled binary hermetic: lm-studio (and any other baked provider)
 *      works with ZERO external models.json, yet users can still layer their
 *      own global/repo configs for OTHER providers.
 *
 * ## Opt-out (self-contained mode)
 *
 *   PI_SKIP_MODELS_JSON=1  →  skip #1 and #2 entirely (ModelRegistry.inMemory).
 *   Only baked-in providers remain. Use this when distributing a binary that
 *   must not read any host file.
 *
 *   Default (unset / "0"): load #1 + #2 + #3.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  type AuthStorage as AuthStorageType,
  ModelRegistry,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural mirror of pi's `ProviderConfigInput` (not re-exported from the
 * package root). registerProvider accepts anything shaped like this.
 */
export interface BakedModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface BakedProvider {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models: BakedModel[];
}

/** A provider entry plus the key under which to register it. */
export interface ProviderRegistration {
  providerName: string;
  config: BakedProvider;
}

// ---------------------------------------------------------------------------
// Defaults — mirror pi's parseModels so registerProvider-loaded providers
// behave identically to natively-loaded ones.
// ---------------------------------------------------------------------------

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Normalize a raw models.json provider entry into a registerProvider config,
 * applying pi's field defaults (cost, input, reasoning, name, compat merge).
 *
 * pi's own `parseModels` applies these defaults when loading models.json
 * natively; `registerProvider` does NOT, so we do it here to keep both paths
 * consistent.
 */
export function normalizeProviderEntry(
  raw: BakedProvider,
): BakedProvider {
  const providerCompat = raw.compat;
  const models = (raw.models ?? []).map((m) => {
    const out: BakedModel = {
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ["text"],
      cost: m.cost ?? DEFAULT_COST,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    };
    if (m.api) out.api = m.api;
    if (m.baseUrl) out.baseUrl = m.baseUrl;
    if (m.headers) out.headers = m.headers;
    // Merge provider-level compat onto model-level (model wins on clash),
    // matching pi's mergeCompat semantics for shallow boolean compat objects.
    if (providerCompat || m.compat) {
      out.compat = { ...(providerCompat ?? {}), ...(m.compat ?? {}) };
    }
    return out;
  });
  const cfg: BakedProvider = { models };
  if (raw.name) cfg.name = raw.name;
  if (raw.baseUrl) cfg.baseUrl = raw.baseUrl;
  if (raw.api) cfg.api = raw.api;
  if (raw.apiKey) cfg.apiKey = raw.apiKey;
  if (raw.headers) cfg.headers = raw.headers;
  if (raw.authHeader !== undefined) cfg.authHeader = raw.authHeader;
  if (raw.compat) cfg.compat = raw.compat;
  return cfg;
}

// ---------------------------------------------------------------------------
// Baked-in providers — the self-contained fallback. Edit this constant to
// change what the hermetic binary ships with. Registered LAST, always wins.
// ---------------------------------------------------------------------------

/**
 * Curated providers baked into bun-pi-agent-cli.
 *
 * lm-studio points at a local LM Studio server; its API key is dummy
 * (LM Studio does not validate it). Resolved at call time so env overrides
 * (LM_STUDIO_API_KEY / LM_STUDIO_BASE_URL) still work.
 */
function bakedProviders(): ProviderRegistration[] {
  const lmStudio: BakedProvider = {
    name: "LM Studio (local, baked)",
    baseUrl: process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1",
    api: "openai-completions",
    apiKey: process.env.LM_STUDIO_API_KEY ?? "lm-studio",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [
      {
        id: "google/gemma-4-26b-a4b-qat",
        name: "Gemma 4 26B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "google/gemma-4-31b-qat",
        name: "Gemma 4 31B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "qwen/qwen3-vl-4b",
        name: "Qwen3 VL 4B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 131072,
        maxTokens: 16384,
      },
    ],
  };
  return [{ providerName: "lm-studio", config: lmStudio }];
}

// ---------------------------------------------------------------------------
// Repo-local models.json loader (#2)
// ---------------------------------------------------------------------------

/** Resolve the repo-local models.json path (relative to this source file). */
function defaultRepoModelsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <repo>/bun-pi-agent-cli/src/providers  →  ../../../  = <repo>
  const repoRoot = resolve(here, "../../..");
  return join(repoRoot, ".pi/agent/models.json");
}

interface ModelsJsonFile {
  providers?: Record<string, BakedProvider>;
}

/**
 * Read a models.json file and return provider registrations (normalized).
 * Returns [] when the file is missing or has no providers. Never throws.
 */
export function loadRepoLocalProviders(
  filePath: string = defaultRepoModelsPath(),
): ProviderRegistration[] {
  if (!existsSync(filePath)) return [];
  let parsed: ModelsJsonFile;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8")) as ModelsJsonFile;
  } catch {
    return [];
  }
  const providers = parsed.providers ?? {};
  return Object.entries(providers).map(([providerName, cfg]) => ({
    providerName,
    config: normalizeProviderEntry(cfg),
  }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface BuildRegistryOptions {
  /**
   * Auth storage the registry must share. When omitted, one is created:
   * AuthStorage.create(<agentDir>/auth.json) by default, or
   * AuthStorage.inMemory() under opt-out (self-contained mode).
   */
  authStorage?: AuthStorageType;
  /**
   * Directory for the default auth.json (when authStorage is omitted).
   * Defaults to pi's getAgentDir() (honors PI_CODING_AGENT_DIR).
   */
  agentDir?: string;
  /**
   * Path to the GLOBAL models.json. When omitted, pi's default
   * (~/.pi/agent/models.json, honors PI_CODING_AGENT_DIR) is used — but ONLY
   * when models.json loading is not skipped.
   */
  globalModelsJsonPath?: string;
  /** Path to the REPO-LOCAL models.json. Defaults to <repo>/.pi/agent/models.json. */
  repoModelsJsonPath?: string;
  /**
   * Force skip of both #1 and #2 (self-contained mode). Defaults to the
   * PI_SKIP_MODELS_JSON env var ("1" / "true" → skip).
   */
  skipModelsJson?: boolean;
}

export interface BuiltRegistry {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /** Whether external models.json files were skipped. */
  selfContained: boolean;
}

function isSkipModelsJson(): boolean {
  const v = process.env.PI_SKIP_MODELS_JSON;
  return v === "1" || v === "true";
}

/**
 * Build a ModelRegistry implementing the layered resolution described at the
 * top of this file. Caller injects the returned `authStorage` + `modelRegistry`
 * into createAgentSessionServices so the agent actually uses them.
 */
export function buildModelRegistry(opts: BuildRegistryOptions = {}): BuiltRegistry {
  const skip = opts.skipModelsJson ?? isSkipModelsJson();

  // Auth storage: real file by default (so user credentials in auth.json still
  // work for non-baked providers), in-memory only under opt-out.
  const authStorage =
    opts.authStorage ??
    (skip
      ? AuthStorage.inMemory()
      : AuthStorage.create(join(opts.agentDir ?? getAgentDir(), "auth.json")));

  // #1 GLOBAL — or inMemory under opt-out.
  let registry: ModelRegistry;
  if (skip) {
    registry = ModelRegistry.inMemory(authStorage);
  } else if (opts.globalModelsJsonPath) {
    registry = ModelRegistry.create(authStorage, opts.globalModelsJsonPath);
  } else {
    registry = ModelRegistry.create(authStorage);
  }

  // #2 REPO-LOCAL (skipped under opt-out).
  if (!skip) {
    for (const { providerName, config } of loadRepoLocalProviders(opts.repoModelsJsonPath)) {
      registry.registerProvider(providerName, config as never);
    }
  }

  // #3 BAKED — always last, always overwrites.
  for (const { providerName, config } of bakedProviders()) {
    registry.registerProvider(providerName, normalizeProviderEntry(config) as never);
  }

  return { authStorage, modelRegistry: registry, selfContained: skip };
}
