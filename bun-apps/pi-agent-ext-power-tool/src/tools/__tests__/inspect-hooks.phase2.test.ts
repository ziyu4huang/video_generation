/**
 * Phase 2 (Task 1) — firing-count intercept integration tests.
 *
 * These drive the REAL SDK `ExtensionRunner`: register handlers, `runner.emit()`
 * N times, then read the snapshot back via `collectHooks` and assert each hook
 * entry carries `fired === N`. This is the highest-fidelity proof that the
 * in-place counting wrapper (installed from the patched `createContext`) really
 * intercepts SDK dispatch.
 *
 * NOTE on fidelity: `loadExtensionFromFactory` is the SDK's public-ish helper
 * for registering an extension via a factory, but it is NOT re-exported through
 * the package's root entry (and the package `exports` map blocks deep imports).
 * So registration here uses a faithful mirror of the SDK's `createExtensionAPI.on()`
 * (assertActive + push to the handlers Map) against a real `ExtensionRuntime`. The
 * dispatch path under test — `ExtensionRunner.emit()` → `createContext()` [patched]
 * → `wrapHookHandlers()` → live handlers array — is 100% real SDK code.
 */
import { test, expect, describe } from "bun:test";
import {
  ExtensionRunner,
  createExtensionRuntime,
  type Extension,
  type ExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { ensureGetSystemPromptOptions } from "../../sdk-patch.js";
import {
  collectHooks,
  getHookFiringCount,
  wrapHookHandlers,
} from "../../runner-hooks.js";

// Install the createContext prototype patch ONCE (same guard as production).
// After this, every ExtensionRunner.createContext() runs applyContextPolyfills,
// which calls wrapHookHandlers() — so emit() wraps handlers before dispatch.
ensureGetSystemPromptOptions();

type AnyFn = (...args: any[]) => unknown;

/**
 * Build a real, dispatchable extension: a real SDK `ExtensionRuntime` plus a
 * faithful mirror of the SDK's `createExtensionAPI.on()`. Returns the Extension
 * (with a populated `handlers` Map) and the runtime.
 */
function buildExtension(
  path: string,
  register: (on: (event: string, handler: AnyFn) => void) => void,
): { ext: Extension; runtime: ExtensionRuntime } {
  const runtime = createExtensionRuntime();
  const ext = {
    path,
    resolvedPath: path,
    handlers: new Map<string, AnyFn[]>(),
  } as unknown as Extension;
  const on = (event: string, handler: AnyFn) => {
    runtime.assertActive(); // mirrors SDK createExtensionAPI.on exactly
    const map = (ext as unknown as { handlers: Map<string, AnyFn[]> }).handlers;
    const list = map.get(event) ?? [];
    list.push(handler);
    map.set(event, list);
  };
  register(on);
  return { ext, runtime };
}

/** Construct a real ExtensionRunner. sessionManager + modelRegistry are stored
 *  by the ctor but emit()/createContext() never touch them in this scenario, so
 *  minimal stubs are sufficient for dispatch. */
function newRunner(ext: Extension, runtime: ExtensionRuntime): ExtensionRunner {
  return new ExtensionRunner([ext], runtime, "/cwd", {} as never, {} as never);
}

const emit = (runner: ExtensionRunner, type: string) =>
  runner.emit({ type } as never);

describe("inspect_hooks Phase 2 — firing counts (real ExtensionRunner)", () => {
  test("fired increments on real dispatch via runner.emit()", async () => {
    let sideEffects = 0;
    const { ext, runtime } = buildExtension("bun-apps/ext-a/a.ts", (on) => {
      on("turn_end", () => {
        sideEffects += 1;
      });
    });
    const runner = newRunner(ext, runtime);

    for (let i = 0; i < 3; i++) await emit(runner, "turn_end");

    expect(sideEffects).toBe(3); // original fn still runs (identity preserved)
    const snap = collectHooks((runner as unknown as { extensions: unknown }).extensions);
    const h = snap.extensions[0].hooks.find((x) => x.event === "turn_end")!;
    expect(h.count).toBe(1);
    expect(h.fired).toBe(3);
  });

  test("a handler whose event is NEVER emitted → fired === 0", async () => {
    const { ext, runtime } = buildExtension("bun-apps/ext-a/a.ts", (on) => {
      on("turn_end", () => {});
      on("tool_execution_start", () => {}); // never emitted below
    });
    const runner = newRunner(ext, runtime);

    await emit(runner, "turn_end"); // only turn_end fires

    const snap = collectHooks((runner as unknown as { extensions: unknown }).extensions);
    const never = snap.extensions[0].hooks.find((x) => x.event === "tool_execution_start")!;
    expect(never.count).toBe(1);
    expect(never.fired).toBe(0);
    const fired = snap.extensions[0].hooks.find((x) => x.event === "turn_end")!;
    expect(fired.fired).toBe(1);
  });

  test("idempotent: repeated emit / getHooks never double-counts or double-wraps", async () => {
    const { ext, runtime } = buildExtension("bun-apps/ext-a/a.ts", (on) => {
      on("turn_end", () => {});
    });
    const runner = newRunner(ext, runtime);

    await emit(runner, "turn_end");
    await emit(runner, "turn_end");

    // Multiple createContext (emit) walks + multiple getHooks reads: no inflation.
    const s1 = collectHooks((runner as unknown as { extensions: unknown }).extensions);
    const s2 = collectHooks((runner as unknown as { extensions: unknown }).extensions);
    expect(s1.extensions[0].hooks[0].fired).toBe(2);
    expect(s2.extensions[0].hooks[0].fired).toBe(2);

    // The original handler is wrapped exactly once: the live array has one
    // callable entry (the wrapper), not a chain of wrappers.
    const arr = (ext as unknown as { handlers: Map<string, AnyFn[]> }).handlers.get("turn_end")!;
    expect(arr.length).toBe(1);
    expect(typeof arr[0]).toBe("function");
    expect(getHookFiringCount(arr[0])).toBe(2);
  });

  test("original handler identity preserved — orig still runs with the real event", async () => {
    const seen: string[] = [];
    const { ext, runtime } = buildExtension("bun-apps/ext-a/a.ts", (on) => {
      on("turn_end", (e: { type: string }) => {
        seen.push(e.type);
      });
    });
    const runner = newRunner(ext, runtime);

    await emit(runner, "turn_end");

    expect(seen).toEqual(["turn_end"]); // orig invoked, with the real event payload
    // The live array entry is the wrapper; getHookFiringCount unwraps it correctly.
    const wrapper = (ext as unknown as { handlers: Map<string, AnyFn[]> }).handlers.get("turn_end")![0];
    expect(getHookFiringCount(wrapper)).toBe(1);
  });

  test("fired is 0 when read before any emit (handlers still unwrapped = orig)", () => {
    const { ext, runtime } = buildExtension("bun-apps/ext-a/a.ts", (on) => {
      on("turn_end", () => {});
    });
    const runner = newRunner(ext, runtime);

    // No emit yet — handlers are still the original (unwrapped) fns.
    const snap = collectHooks((runner as unknown as { extensions: unknown }).extensions);
    expect(snap.extensions[0].hooks[0].fired).toBe(0);
    expect(snap.extensions[0].hooks[0].count).toBe(1);
  });
});

describe("inspect_hooks Phase 2 — pure unit guards", () => {
  test("wrapHookHandlers is a no-op on non-array / shape-drift input", () => {
    expect(() => wrapHookHandlers(undefined)).not.toThrow();
    expect(() => wrapHookHandlers({})).not.toThrow();
    expect(() => wrapHookHandlers([{ path: "x.ts" }])).not.toThrow(); // no handlers map
    expect(() => wrapHookHandlers([{ path: "x.ts", handlers: "not-a-map" }])).not.toThrow();
  });

  test("getHookFiringCount defaults to 0 for an untracked fn", () => {
    expect(getHookFiringCount(() => {})).toBe(0);
    expect(getHookFiringCount((() => {}) as never)).toBe(0);
  });

  test("direct-wrap fallback path: drive the wrap without emit", () => {
    // Exercises wrapHookHandlers + collectHooks directly (the reduced-fidelity
    // fallback the brief mentions) — proves the wrap mechanism in isolation.
    const orig: AnyFn = () => 42;
    const ext = {
      path: "direct.ts",
      handlers: new Map([["turn_end", [orig]]]),
    };
    wrapHookHandlers([ext]);
    const arr = ext.handlers.get("turn_end")!;
    expect(arr[0]).not.toBe(orig); // replaced in-place with the wrapper
    arr[0](); // fire once
    arr[0](); // fire twice
    expect(getHookFiringCount(arr[0])).toBe(2);
    const snap = collectHooks([ext]);
    expect(snap.extensions[0].hooks[0]).toEqual({ event: "turn_end", count: 1, fired: 2 });
  });
});
