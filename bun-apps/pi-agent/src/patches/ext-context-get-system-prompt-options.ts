/**
 * ext-context-get-system-prompt-options — monkey-patch ExtensionRunner.prototype.createContext
 * so getSystemPromptOptions() is available on the base ExtensionContext interface (not just
 * ExtensionCommandContext).
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The upstream @earendil-works/pi-coding-agent 0.80.3 added `getSystemPromptOptions()` to
 * `ExtensionCommandContext` (command handlers only) but NOT to the base `ExtensionContext`
 * used by event handlers. Our extensions (context_analyzer, agent_inventory,
 * extension_analyzer) need `getSystemPromptOptions()` inside their execute() callbacks,
 * which receive `ExtensionContext`, not `ExtensionCommandContext`.
 *
 * The fix was applied directly to the bun cache (non-durable — lost on `bun install`).
 * This patch makes it durable by patching the runner's prototype at import time.
 *
 * PATCH LOGIC
 * -----------
 *   function createContext() {                               function createContext() {
 *     return {                                                    return {
 *       ...getSystemPrompt,         →                              ...getSystemPrompt,
 *       ...other methods,                                          getSystemPromptOptions,  ← ADDED
 *     };                                                            ...other methods,
 *   }                                                            }
 * }
 *
 * createCommandContext() already spreads from createContext() via
 * Object.defineProperties({}, Object.getOwnPropertyDescriptors(this.createContext())),
 * so adding `getSystemPromptOptions` to createContext() automatically propagates it
 * to command contexts — no separate change needed there.
 *
 * Env gate: BUN_PI_EXT_CTX_GET_SYSTEM_PROMPT_OPTIONS (default on). Reversible.
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

// ── Module-scoped flag: apply once ──────────────────────────────────────────
let applied = false;

/**
 * Patch ExtensionRunner.prototype.createContext to inject getSystemPromptOptions
 * into the returned ExtensionContext object.
 */
export function applyGetSystemPromptOptionsPatch(): boolean {
  if (applied) return false;
  const proto = ExtensionRunner.prototype as Record<string, unknown>;
  const original = proto.createContext as (() => Record<string, unknown>) | undefined;
  if (!original || typeof original !== "function") return false;

  proto.createContext = function (this: ExtensionRunner) {
    const ctx = original.call(this);
    // If the SDK itself already provides it (upstream fix landed), do nothing.
    if (typeof ctx.getSystemPromptOptions === "function") return ctx;

    const self = this as unknown as {
      getSystemPromptOptionsFn: () => Record<string, unknown>;
      assertActive: () => void;
    };
    Object.defineProperty(ctx, "getSystemPromptOptions", {
      get: () => {
        self.assertActive();
        return self.getSystemPromptOptionsFn();
      },
      enumerable: true,
      configurable: true,
    });
    return ctx;
  } as () => Record<string, unknown>;

  applied = true;
  return true;
}

// Import-time side effect
const debug =
  process.env.BUN_PI_DEBUG_PATCHES === "1" ||
  process.env.BUN_PI_DEBUG_PATCHES === "true";
const enabled = process.env.BUN_PI_EXT_CTX_GET_SYSTEM_PROMPT_OPTIONS !== "0";
if (enabled) {
  const ok = applyGetSystemPromptOptionsPatch();
  if (debug) {
    console.error(
      `[bun-pi] ext-context-get-system-prompt-options: ${ok ? "applied" : "already applied or failed"}`,
    );
  }
}

export const extContextGetSystemPromptOptionsPatchApplied = true;
