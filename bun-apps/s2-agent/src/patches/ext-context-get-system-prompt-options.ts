/**
 * ext-context-get-system-prompt-options — monkey-patch ExtensionRunner.prototype.createContext
 * so getSystemPromptOptions() is available on the base ExtensionContext interface (not just
 * ExtensionCommandContext).
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The upstream @earendil-works/pi-coding-agent 0.80.3 added `getSystemPromptOptions()` to
 * `ExtensionCommandContext` (command handlers only) but NOT to the base `ExtensionContext`
 * used by event handlers. Our extensions (inspect_context, inspect_agent,
 * inspect_extensions) need `getSystemPromptOptions()` inside their execute() callbacks,
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
 * createCommandContext() copies descriptors from createContext() via
 * Object.defineProperties({}, Object.getOwnPropertyDescriptors(this.createContext()))
 * and then OVERWRITES `getSystemPromptOptions` on the command context via plain
 * assignment (`context.getSystemPromptOptions = () => {...}`). For that assignment
 * to succeed, the property we add here MUST be a writable, configurable DATA
 * property — NOT a getter-only accessor. A getter-only accessor copied through
 * getOwnPropertyDescriptors makes the command-context property non-assignable,
 * and strict-mode assignment throws `Attempted to assign to readonly property`,
 * which breaks EVERY extension slash-command (e.g. /goal) at dispatch time.
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
  const proto = ExtensionRunner.prototype as unknown as Record<string, unknown>;
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
    // IMPORTANT: define as a writable data property, NOT a getter. createCommandContext()
    // copies this property's descriptor via getOwnPropertyDescriptors + defineProperties
    // and then overwrites it with `context.getSystemPromptOptions = () => {...}`. A
    // getter-only accessor would make that assignment throw in strict mode
    // ("Attempted to assign to readonly property"), breaking all /commands.
    Object.defineProperty(ctx, "getSystemPromptOptions", {
      value: () => {
        self.assertActive();
        return self.getSystemPromptOptionsFn();
      },
      writable: true,
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
let outcome = false;
if (enabled) {
  const ok = applyGetSystemPromptOptionsPatch();
  outcome = ok;
  if (debug) {
    console.error(
      `[bun-pi] ext-context-get-system-prompt-options: ${ok ? "applied" : "already applied or failed"}`,
    );
  }
}

/**
 * Whether the wrap actually bound. `applyPatches()` reads this and reports a
 * false as a patch failure instead of claiming success — see ./index.ts.
 * `enabled === false` (env opt-out) is reported as applied: the patch did
 * exactly what it was asked to do.
 */
export const patchApplied = enabled ? outcome : true;
