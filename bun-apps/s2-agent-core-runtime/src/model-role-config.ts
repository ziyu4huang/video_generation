/**
 * Model-role configuration — the LEAF resolver for tier + capability → model-spec.
 *
 * Split from model-tier-config.ts so a DIRECT importer can resolve a model role
 * without pulling in available-models.ts, and with it the pi-coding-agent SDK.
 * Barrel consumers (file2md reaches this through `@repo/s2-agent-ext-subagent`)
 * load the whole package either way — the saving is only for direct imports.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_TIERS_FILE } from "./config.js";
import { logModelDecision } from "./debug-models.js";
import { homeDir } from "./home.js";

/**
 * Model tier + capability configuration. `tiers` maps size names
 * (small/medium/big) → model-spec; `capabilities` maps capability names
 * (vision, …) → model-spec. Both are "provider/model-id[:thinking]" strings.
 */
export interface ModelTierConfig {
  tiers: Record<string, string>;
  /** Capability → model-spec (e.g. { vision: "lmstudio/google/gemma-4-12b" }). Optional.
   * Supports tiered keys ("vision-large"/"vision-medium"/"vision-small") that
   * fall back to the un-suffixed capability ("vision") when not set separately. */
  capabilities?: Record<string, string>;
}

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homeDir(), MODEL_TIERS_FILE);
}

/**
 * TRANSIENT (session-scope) OVERRIDE — set by `/models-preset`, never by
 * anything that persists. ADR-subagent-0006: presets are a SESSION switch
 * (main model + tier/capability routing), not a config write. `~/.pi` stays
 * built-in-pure — the only writer of model-tiers.json is the ensure-model-tiers
 * startup seed of the built-in default.
 *
 * Process-scope on purpose: the TUI process (or any host that applied a preset)
 * routes tiers by the override; child processes and fresh starts see nothing.
 * The subagent extension clears it on `session_start` so switching or starting
 * a session resets to file/built-in routing.
 *
 * RESOLUTION consumers (agent-model, agent, budget-defaults,
 * spawn-subagent-subprocess) read through getEffectiveModelTierConfig(); FILE
 * consumers (/workflows-models editor, file2md fallback) keep calling
 * loadModelTierConfig() directly so the editor shows what a save would write.
 */
let transientConfig: ModelTierConfig | null = null;

/** Set (or clear, with null) the transient session-scope tier config. */
export function setTransientModelTierConfig(config: ModelTierConfig | null): void {
  transientConfig = config;
  logModelDecision("transient-config", { action: config ? "set" : "clear", ...(config ?? {}) });
}

/** Read the transient session-scope tier config (null when none applied). */
export function getTransientModelTierConfig(): ModelTierConfig | null {
  return transientConfig;
}

/**
 * The config RESOLUTION should use: the transient override when one is active
 * (a preset applied this session), else the on-disk file. Pure read — never
 * writes, never seeds.
 */
export function getEffectiveModelTierConfig(): ModelTierConfig | null {
  return transientConfig ?? loadModelTierConfig();
}

/** Load the config from disk. Returns null if absent or unparseable.
 * FILE-ONLY by contract: this never reflects the transient override — callers
 * that must resolve a tier/capability use getEffectiveModelTierConfig(). */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) {
    logModelDecision("load-config", { path, result: "absent" });
    return null;
  }
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
    logModelDecision("load-config", { path, result: "loaded", ...parsed });
    return parsed as ModelTierConfig;
  } catch {
    logModelDecision("load-config", { path, result: "unparseable" });
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
  if (opts.capability) {
    const direct = config.capabilities?.[opts.capability];
    if (direct) return direct;
    // Tiered-capability fallback: "vision-large" → "vision" when the tiered
    // key isn't configured separately. Single-slot configs keep working for
    // every tier; an exact tiered key always wins.
    const dash = opts.capability.lastIndexOf("-");
    if (dash > 0) return config.capabilities?.[opts.capability.slice(0, dash)];
    return undefined;
  }
  if (opts.tier) return config.tiers[opts.tier];
  return undefined;
}

/** Tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
