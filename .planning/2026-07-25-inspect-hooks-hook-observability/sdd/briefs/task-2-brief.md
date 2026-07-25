## Task 2: `getHooks()` polyfill in `sdk-patch.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/__tests__/sdk-patch.test.ts`

**Interfaces:**
- Consumes: `collectHooks`, `HooksSnapshot` (from `./tools/inspect-hooks.js`).
- Produces: `applyContextPolyfills(ctx, runner)` (exported), `PolyfillRunner` (type), and the `getHooks()` method on `ExtensionContext` (via module augmentation). `ensureGetSystemPromptOptions()` now installs all three polyfills through `applyContextPolyfills`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sdk-patch.test.ts`:

```ts
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
      extensions: [{ path: "ext.ts", hooks: [{ event: "turn_end", count: 2 }] }],
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

  test("installs getSystemPromptOptions + getSystemPrompt (unchanged behavior)", () => {
    const ctx: Record<string, unknown> = {};
    applyContextPolyfills(ctx, fakeRunner([]));
    expect(typeof ctx.getSystemPromptOptions).toBe("function");
    expect(typeof ctx.getSystemPrompt).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/__tests__/sdk-patch.test.ts )
```
Expected: FAIL — `applyContextPolyfills` is not exported (does not exist yet).

- [ ] **Step 3: Refactor sdk-patch.ts — extract `applyContextPolyfills`, add `getHooks`**

Edit `src/sdk-patch.ts`. Replace the existing module-augmentation block AND the inline polyfill-additions inside `proto.createContext` with the refactored version below.

**3a.** Replace the `declare module { ... }` block (currently augments only `getSystemPromptOptions`) with:

```ts
import { collectHooks, type HooksSnapshot } from "./tools/inspect-hooks.js";

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
}
```

> Remove the now-duplicate top-of-file `import { createRequire }...`? NO — keep it; the `sdkRequire` is still used below. The new `import { collectHooks, type HooksSnapshot }` is an ADDITIONAL import line at the top (merge into the existing import group).

**3b.** Inside `ensureGetSystemPromptOptions`, replace the inline polyfill-addition block:

```ts
      proto.createContext = function (this: unknown, ...args: unknown[]) {
        const ctx = origCreateContext.apply(this, args);
        applyContextPolyfills(ctx as Record<string, unknown>, this as PolyfillRunner);
        return ctx;
      };
```

(This replaces the previous block that set `ctx.getSystemPromptOptions` / `ctx.getSystemPrompt` inline. Delete the `runnerThis` const and the two `if (typeof ctx.… !== "function")` blocks — they now live in `applyContextPolyfills`.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/__tests__/sdk-patch.test.ts )
```
Expected: PASS.

- [ ] **Step 5: Run the FULL existing suite to confirm the refactor didn't break getSystemPromptOptions consumers**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test )
```
Expected: PASS — all pre-existing tests still green (the refactor is behavior-preserving for getSystemPromptOptions/getSystemPrompt).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts \
        bun-apps/pi-agent-ext-power-tool/src/__tests__/sdk-patch.test.ts
git commit -m "feat(power-tool): add getHooks() to sdk-patch createContext polyfill (reads runner.extensions[].handlers)"
```

---

