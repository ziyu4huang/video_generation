/**
 * `/models-preset` command handler — TRANSIENT session switch.
 *
 * Applies a named model-config preset to the CURRENT session only:
 *   - the main model switches live (pi.setModel — takes effect next turn), and
 *   - tier/capability routing for subagents dispatched this session follows
 *     the preset via the in-memory transient override
 *     (setTransientModelTierConfig — see ADR-subagent-0006).
 *
 * It NEVER writes to disk. No ~/.pi/workflows/model-tiers.json, no .bak —
 * the only writer of that file is the ensure-model-tiers startup seed of the
 * built-in default. Restarting the TUI, or starting/switching a session
 * (session_start clears the override), returns to file/built-in routing.
 *
 * Usage:
 *   /models-preset              → interactive picker
 *   /models-preset <id>         → apply <id> directly (e.g. glm-lmstudio)
 *
 * Side effects are dependency-injected (model resolution + transient set are
 * defaults to the real pi/model-role-config functions) so the command is
 * unit-testable WITHOUT mock.module (which would leak across test files under
 * bun's shared-realm default) — and so the tests can pin the no-writes
 * contract (there is no save/write dep to fake at all).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";
import { setTransientModelTierConfig } from "@repo/s2-agent-core-runtime";
import { findPreset, MODEL_PRESETS, mainModelSpec } from "../src/presets.js";

/** Result of attempting the main-model switch. */
export interface SwitchResult {
  ok: boolean;
  /** Human-readable failure reason when !ok. */
  reason?: string;
}

/** Injectable side effects (defaults hit the live pi API). */
export interface PresetCommandDeps {
  /** Resolve + apply a `provider/id[:thinking]` spec to the main session. */
  switchMainModel?: (spec: string, ctx: ExtensionCommandContext) => Promise<SwitchResult>;
  /** Install the transient tier/capability override. */
  setTransientConfig?: (cfg: ModelTierConfig) => void;
}

/** Parse a `provider/id[:thinking]` spec. Exported for tests. */
export function parseModelSpec(spec: string): { provider: string; modelId: string; thinking?: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1) return undefined;
  const provider = spec.slice(0, slash);
  let rest = spec.slice(slash + 1);
  let thinking: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > 0) {
    thinking = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest) return undefined;
  return { provider, modelId: rest, thinking };
}

/** Build the command handler (factory, mirroring createSubagentsCommand). */
export function createModelsPresetCommand(pi: ExtensionAPI, deps: PresetCommandDeps = {}) {
  const switchMainModel =
    deps.switchMainModel ??
    (async (spec: string, ctx: ExtensionCommandContext): Promise<SwitchResult> => {
      const parsed = parseModelSpec(spec);
      if (!parsed) return { ok: false, reason: `malformed model spec "${spec}" (expected provider/id)` };
      const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
      if (!model) {
        return { ok: false, reason: `"${spec}" is not in the model catalog (provider or model id unknown)` };
      }
      const ok = await pi.setModel(model);
      if (!ok)
        return { ok: false, reason: `no API key configured for ${parsed.provider} — /login or set the key first` };
      if (parsed.thinking) {
        try {
          pi.setThinkingLevel(parsed.thinking as never);
        } catch {
          // best-effort: an unsupported level is clamped/rejected by pi itself
        }
      }
      return { ok: true };
    });
  const setTransientConfig = deps.setTransientConfig ?? setTransientModelTierConfig;

  async function applyPreset(presetId: string, ctx: ExtensionCommandContext): Promise<void> {
    const preset = findPreset(presetId);
    if (!preset) return; // caller already validated

    const mainSpec = mainModelSpec(preset);
    if (!mainSpec) {
      ctx.ui.notify(`Preset "${preset.id}" has no tier models — nothing to switch to.`, "error");
      return;
    }
    const switched = await switchMainModel(mainSpec, ctx);
    if (!switched.ok) {
      ctx.ui.notify(`Could not switch to "${preset.label}": ${switched.reason}`, "error");
      return;
    }
    setTransientConfig(preset.config);
    ctx.ui.notify(
      `Session switched to "${preset.label}" — main model ${mainSpec}, tiers + vision routing follow this preset ` +
        `for THIS session only (nothing written to ~/.pi; restart or /models-preset again to change).`,
      "info",
    );
  }

  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    // Direct apply: /models-preset <id>  (Pi passes the raw arg string.)
    const directId = args.trim();
    if (directId) {
      const preset = findPreset(directId);
      if (!preset) {
        ctx.ui.notify(`Unknown preset "${directId}". Available: ${MODEL_PRESETS.map((p) => p.id).join(", ")}`, "error");
        return;
      }
      await applyPreset(directId, ctx);
      return;
    }

    // Interactive picker.
    const options = MODEL_PRESETS.map((p) => `${p.id}  —  ${p.summary}`);
    const sel = await ctx.ui.select("Switch this session's model-config preset", options);
    if (!sel) return;
    const chosen = MODEL_PRESETS.find((p) => sel.startsWith(p.id));
    if (!chosen) return;
    await applyPreset(chosen.id, ctx);
  };
}

/** Register the `/models-preset` command with Pi. */
export function registerModelsPresetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("models-preset", {
    description:
      "Transiently switch THIS session's model config (main model + subagent tiers/vision) — nothing is written to ~/.pi",
    handler: createModelsPresetCommand(pi),
  });
}
