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

import { createRequire } from "node:module";
import { collectHooks, wrapHookHandlers, type HooksSnapshot } from "./runner-hooks.js";

let patched = false;
const sdkRequire = createRequire(import.meta.url);

// Runtime: ensureGetSystemPromptOptions() polyfills getSystemPromptOptions() AND
// getHooks() onto the tool execution context (ExtensionContext) — the SDK only
// declares them on ExtensionCommandContext / not at all. This module augmentation
// mirrors the runtime polyfill at the TYPE level. (Keep in sync with the runtime
// patch below.)
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionContext {
    getSystemPromptOptions(): import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions;
    getHooks(): HooksSnapshot;
  }
}

/** The slice of the runner instance the polyfills read. */
export interface PolyfillRunner {
  assertActive(): void;
  getSystemPromptOptionsFn(): import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions;
  getSystemPromptFn(): string;
  /** runner.extensions — the aggregate all hook handlers are stored on. */
  extensions?: unknown[];
}

/**
 * Install all context polyfills onto a ctx object. PURE w.r.t. ctx (mutates it).
 * Exported so it is unit-testable without resolving the real Runner prototype.
 * Each polyfill is independently guarded: a getHooks failure (caught) does NOT
 * affect getSystemPromptOptions, and vice-versa.
 */
export function applyContextPolyfills(
  ctx: Record<string, unknown>,
  runner: PolyfillRunner,
): void {
  if (typeof ctx.getSystemPromptOptions !== "function") {
    ctx.getSystemPromptOptions = () => {
      runner.assertActive();
      return runner.getSystemPromptOptionsFn();
    };
  }
  if (typeof ctx.getSystemPrompt !== "function") {
    ctx.getSystemPrompt = () => {
      runner.assertActive();
      return runner.getSystemPromptFn();
    };
  }
  if (typeof ctx.getHooks !== "function") {
    ctx.getHooks = (): HooksSnapshot => {
      try {
        runner.assertActive();
        return collectHooks(runner.extensions);
      } catch {
        return { extensions: [], available: false };
      }
    };
  }
  // Phase 2: idempotently install the counting wrapper on every registered hook
  // handler, IN-PLACE on the live extension.handlers arrays. The SDK emit() calls
  // createContext() at the top of every emit before reading handlers live, so
  // this wrap lands before dispatch on the first emit. Cheap + idempotent (one
  // Symbol check per handler per emit) — safe on the hot emit path.
  wrapHookHandlers(runner.extensions);
}

export function ensureGetSystemPromptOptions(): boolean {
  if (patched) return true;

  try {
    // The SDK's exports map (0.80.3) only exposes "." and "./rpc-entry", so a
    // bare deep-subpath require(".../dist/core/extensions/runner.js") fails with
    // "Cannot find module". Resolve the SDK package.json (always resolvable) and
    // derive the runner path from it — a direct file-path require bypasses the
    // exports map.
    const pkgJsonPath = sdkRequire.resolve(
      "@earendil-works/pi-coding-agent/package.json",
    );
    const runnerMod = require(
      pkgJsonPath.replace(/package\.json$/, "dist/core/extensions/runner.js"),
    );
    // The runner class was renamed PiAgentRunner → ExtensionRunner; look it up
    // by the createContext method on its prototype (name-agnostic) so a future
    // rename doesn't silently break the polyfill again.
    const Runner: unknown =
      runnerMod.default ??
      Object.values(runnerMod).find(
        (v: unknown) =>
          typeof v === "function" &&
          typeof (v as { prototype?: { createContext?: unknown } }).prototype?.createContext ===
            "function",
      );

    if (!Runner || typeof Runner !== "function") {
      console.warn(
        "[sdk-patch] runner class with createContext not found — getSystemPromptOptions() polyfill skipped",
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
      applyContextPolyfills(ctx as Record<string, unknown>, this as PolyfillRunner);
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
