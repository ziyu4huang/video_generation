/**
 * Model-role configuration — the LEAF resolver for tier + capability → model-spec.
 *
 * Split from model-tier-config.ts so lightweight consumers (file2md) can resolve
 * a model role WITHOUT pulling in agent.js (WorkflowAgent machinery). Import via
 * the package barrel: `@repo/pi-agent-ext-subagent`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_TIERS_FILE } from "./config.js";
import { homeDir } from "./home.js";

/**
 * Model tier + capability configuration. `tiers` maps size names
 * (small/medium/big) → model-spec; `capabilities` maps capability names
 * (vision, …) → model-spec. Both are "provider/model-id[:thinking]" strings.
 */
export interface ModelTierConfig {
  tiers: Record<string, string>;
  /** Capability → model-spec (e.g. { vision: "lmstudio/qwen2-vl-7b" }). Optional. */
  capabilities?: Record<string, string>;
}

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homeDir(), MODEL_TIERS_FILE);
}

/** Load the config from disk. Returns null if absent or unparseable. */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.tiers || typeof parsed.tiers !== "object") return null;
    for (const val of Object.values(parsed.tiers)) {
      if (typeof val !== "string") return null;
    }
    if (parsed.capabilities != null) {
      if (typeof parsed.capabilities !== "object") return null;
      for (const val of Object.values(parsed.capabilities)) {
        if (typeof val !== "string") return null;
      }
    }
    return parsed as ModelTierConfig;
  } catch {
    return null;
  }
}

/** Save a config to disk, creating parent dirs. */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

/** Resolve a tier name to its model-spec, or undefined if not configured. */
export function resolveTierModel(tier: string, config: ModelTierConfig): string | undefined {
  return config.tiers[tier];
}

/**
 * Resolve a model ROLE (a tier OR a capability) to its configured model-spec
 * string ("provider/model-id[:thinking]"), or undefined if not configured.
 * If both tier and capability are given, capability wins (callers pass one).
 */
export function resolveModelRole(
  opts: { tier?: string; capability?: string },
  config: ModelTierConfig | null,
): string | undefined {
  if (!config) return undefined;
  if (opts.capability) return config.capabilities?.[opts.capability];
  if (opts.tier) return config.tiers[opts.tier];
  return undefined;
}

/** Tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
