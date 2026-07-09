/**
 * Hook injection-mode derivation.
 *
 * Ported from the upstream planning-with-files runtime (v3.4.0). Pure logic —
 * the only Pi touch is a type-only import of ExtensionContext so the runtime can
 * pass the live model info through.
 *
 *   - `auto`        → derived: DeepSeek → `cache-safe`, otherwise `parity`
 *   - `parity`      → maximum context injection (full plan + progress block)
 *   - `cache-safe`  → stable one-line reminders (DeepSeek KV-cache friendly)
 *   - `notify`      → status-bar only, no model injection
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HookMode = "auto" | "parity" | "cache-safe" | "notify";

/** The non-`auto` mode actually used for injection. */
export type EffectiveMode = Exclude<HookMode, "auto">;

export function parseMode(value: unknown): HookMode | undefined {
  if (value === "auto" || value === "parity" || value === "cache-safe" || value === "notify") {
    return value;
  }
  return undefined;
}

function safeReadJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readModeFromSettings(path: string): HookMode | undefined {
  const parsed = safeReadJson(path);
  const config = parsed?.planningWithFiles as { mode?: unknown } | undefined;
  return parseMode(config?.mode);
}

/**
 * Resolve the configured mode with the same precedence as the upstream runtime:
 * `PWF_MODE` env → project `.pi/settings.json` → global `~/.pi/agent/settings.json`
 * → `auto` (default).
 */
export function resolveConfiguredMode(cwd: string): HookMode {
  const envMode = parseMode(process.env.PWF_MODE?.toLowerCase());
  if (envMode) return envMode;

  const home = process.env.HOME || process.env.USERPROFILE;
  const globalSettings = home ? join(home, ".pi", "agent", "settings.json") : undefined;
  const projectSettings = join(cwd, ".pi", "settings.json");

  const projectMode = readModeFromSettings(projectSettings);
  const globalMode = globalSettings ? readModeFromSettings(globalSettings) : undefined;

  return projectMode ?? globalMode ?? "auto";
}

/** Derive the concrete injection mode from `auto` using the active model. */
export function deriveEffectiveMode(mode: HookMode, ctx: ExtensionContext): EffectiveMode {
  if (mode !== "auto") return mode;
  const provider = (ctx.model?.provider || "").toLowerCase();
  const modelId = (ctx.model?.id || "").toLowerCase();
  const isDeepSeek = provider.includes("deepseek") || modelId.includes("deepseek");
  return isDeepSeek ? "cache-safe" : "parity";
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Opt-in auto-approval of the active plan at session start.
 *
 * Upstream requires an explicit interactive `/plan-execute`. For non-interactive
 * workflows (CI, `-p` batch runs with an already-finalized plan) this is an
 * opt-in escape hatch so the hooks activate without a human in the loop:
 *   - `PWF_AUTO_APPROVE=1` env var, OR
 *   - `{ "planningWithFiles": { "autoApprove": true } }` in `.pi/settings.json`
 * Off by default — interactive users still use `/plan-execute`.
 */
export function resolveAutoApprove(cwd: string): boolean {
  if (TRUTHY.has((process.env.PWF_AUTO_APPROVE ?? "").trim().toLowerCase())) return true;

  const projectSettings = safeReadJson(join(cwd, ".pi", "settings.json"));
  const config = projectSettings?.planningWithFiles as { autoApprove?: unknown } | undefined;
  return config?.autoApprove === true;
}
