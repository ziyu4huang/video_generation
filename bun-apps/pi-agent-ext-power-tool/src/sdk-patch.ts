/**
 * sdk-patch.ts — Runtime SDK compatibility shim.
 *
 * The pi-coding-agent SDK (0.80.3) exposes getSystemPromptOptions() only on
 * ExtensionCommandContext, not on ExtensionContext (tool execute() context).
 *
 * This shim monkey-patches the PiAgentRunner prototype at import time so that
 * tool execute() contexts always have getSystemPromptOptions().
 *
 * It's a MEMORY-ONLY patch — no filesystem writes. Runs once per process, even
 * if imported multiple times.
 *
 * If the patch fails (SDK structure changed), the caller falls back gracefully
 * — tools simply omit the sub-breakdown and show "system prompt: ~X tok total".
 */

let patched = false;

// Runtime: ensureGetSystemPromptOptions() polyfills getSystemPromptOptions()
// onto the tool execution context (ExtensionContext) — the SDK only declares
// it on ExtensionCommandContext. This module augmentation mirrors that runtime
// polyfill at the TYPE level, so power-tool tools can call it on ExtensionContext
// without per-call casts. (Keep in sync with the runtime patch below.)
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionContext {
    getSystemPromptOptions(): import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions;
  }
}

export function ensureGetSystemPromptOptions(): boolean {
  if (patched) return true;

  try {
    // Resolve the runner module from the SDK — Bun resolves the symlink.
    // We need the internal runner module, not the public API.
    const runnerMod = require(
      "@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
    );
    const Runner: unknown =
      runnerMod.default ?? Object.values(runnerMod).find(
        (v: unknown) =>
          typeof v === "function" &&
          (v as { name?: string }).name === "PiAgentRunner" &&
          (v as unknown as { prototype?: { createContext?: unknown } }).prototype?.createContext,
      );

    if (!Runner || typeof Runner !== "function") {
      console.warn(
        "[sdk-patch] PiAgentRunner not found — getSystemPromptOptions() polyfill skipped",
      );
      return false;
    }

    const proto = (Runner as unknown as Record<string, unknown>).prototype as Record<
      string,
      unknown
    >;
    const origCreateContext = proto.createContext as (this: unknown, ...args: unknown[]) => Record<string, unknown>;
    if (typeof origCreateContext !== "function") {
      return false;
    }

    proto.createContext = function (this: unknown, ...args: unknown[]) {
      const ctx = origCreateContext.apply(this, args);
      const runnerThis = this as {
        assertActive(): void;
        getSystemPromptOptionsFn(): Record<string, unknown>;
        getSystemPromptFn(): string;
      };

      if (typeof ctx.getSystemPromptOptions !== "function") {
        ctx.getSystemPromptOptions = () => {
          runnerThis.assertActive();
          return runnerThis.getSystemPromptOptionsFn();
        };
      }
      if (typeof ctx.getSystemPrompt !== "function") {
        ctx.getSystemPrompt = () => {
          runnerThis.assertActive();
          return runnerThis.getSystemPromptFn();
        };
      }
      return ctx;
    };

    patched = true;
    return true;
  } catch (e) {
    console.warn(
      "[sdk-patch] Could not apply getSystemPromptOptions polyfill:",
      (e as Error).message,
    );
    return false;
  }
}
