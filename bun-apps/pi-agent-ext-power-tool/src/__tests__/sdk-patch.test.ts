import { test, expect, describe } from "bun:test";
import { applyContextPolyfills, type PolyfillRunner } from "../sdk-patch.js";

const fakeRunner = (extensions: unknown[]): PolyfillRunner => ({
  assertActive() {},
  getSystemPromptOptionsFn: () => ({}) as never,
  getSystemPromptFn: () => "",
  extensions,
});

describe("applyContextPolyfills", () => {
  test("installs getHooks that reads runner.extensions via collectHooks", () => {
    const ctx: Record<string, unknown> = {};
    const runner = fakeRunner([
      { path: "ext.ts", handlers: new Map([["turn_end", [() => {}, () => {}]]]) },
    ]);
    applyContextPolyfills(ctx, runner);
    expect(typeof ctx.getHooks).toBe("function");
    const snap = (ctx.getHooks as () => unknown)();
    expect(snap).toEqual({
      extensions: [{ path: "ext.ts", hooks: [{ event: "turn_end", count: 2, fired: 0 }] }],
      available: true,
    });
  });

  test("getHooks returns available:false if it throws (independent of getSystemPromptOptions)", () => {
    const ctx: Record<string, unknown> = {};
    const runner: PolyfillRunner = {
      assertActive() { throw new Error("stale"); },
      getSystemPromptOptionsFn: () => ({}) as never,
      getSystemPromptFn: () => "",
      extensions: [],
    };
    applyContextPolyfills(ctx, runner);
    const snap = (ctx.getHooks as () => { available: boolean })();
    expect(snap.available).toBe(false);
    // getSystemPromptOptions is still installed (independent degradation)
    expect(typeof ctx.getSystemPromptOptions).toBe("function");
  });

  test("installs getSystemPromptOptions + getSystemPrompt and they invoke the runner fns", () => {
    const marker = { __marker: true } as never;
    const ctx: Record<string, unknown> = {};
    applyContextPolyfills(ctx, {
      assertActive() {},
      getSystemPromptOptionsFn: () => marker,
      getSystemPromptFn: () => "SP",
      extensions: [],
    });
    expect((ctx.getSystemPromptOptions as () => unknown)()).toBe(marker);
    expect((ctx.getSystemPrompt as () => unknown)()).toBe("SP");
  });
});

// ── the runner lookup (regression guard for the pi-agent-sh deploy) ──────────
//
// ensureGetSystemPromptOptions() used to reach the runner class through
// `createRequire(import.meta.url).resolve(".../package.json")` + a derived deep
// path. The bundler baked the BUILD MACHINE's absolute link-farm path into
// power-tool's cjs bundle, so in a pi-agent-sh deploy the host require (bare
// specifiers only) threw and this polyfill silently never applied — every
// invocation printed a warning and inspect_context / inspect_hooks /
// inspect_extensions ran degraded. Two guards: the behaviour, and the shape
// (the regression is a re-introduced deep path, which the behaviour test cannot
// see because it passes on the build machine).
describe("ensureGetSystemPromptOptions", () => {
  test("resolves the runner class and patches it", async () => {
    const { ensureGetSystemPromptOptions } = await import("../sdk-patch.js");
    expect(ensureGetSystemPromptOptions()).toBe(true);
  });

  test("reaches the SDK by root import only — no createRequire, no deep path", async () => {
    const raw = await Bun.file(new URL("../sdk-patch.ts", import.meta.url)).text();
    // Comments describe the old deep path on purpose; assert against CODE only.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("createRequire");
    expect(code).not.toContain("dist/core/");
    expect(code).toContain('import { ExtensionRunner } from "@earendil-works/pi-coding-agent"');
  });
});
