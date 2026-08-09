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
