# Task 2 Report — `getHooks()` polyfill in `sdk-patch.ts`

## What was implemented

A behavior-preserving refactor of `bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts` that extracts the two existing context polyfills (`getSystemPromptOptions`, `getSystemPrompt`) out of the inline `proto.createContext` patch into a new **exported, unit-testable** function `applyContextPolyfills(ctx, runner)`, and adds a **third** polyfill — `getHooks()` — alongside them.

### Surface added
- **Exported function** `applyContextPolyfills(ctx: Record<string, unknown>, runner: PolyfillRunner): void` — installs all three polyfills onto `ctx`, each independently guarded by `typeof … !== "function"`.
- **Exported type** `PolyfillRunner` — the structural slice of the runner (`assertActive`, `getSystemPromptOptionsFn`, `getSystemPromptFn`, `extensions?`) the polyfills read.
- **`getHooks(): HooksSnapshot`** added to the `declare module "@earendil-works/pi-coding-agent" { interface ExtensionContext { … } }` augmentation.
- New top-of-file import `import { collectHooks, type HooksSnapshot } from "./tools/inspect-hooks.js";` merged into the existing import group. The existing `import { createRequire } from "node:module";` and `sdkRequire`/`patched` machinery were kept intact (per brief note).

### Behavior of `getHooks`
- On success: `runner.assertActive()` then `collectHooks(runner.extensions)` → typed `HooksSnapshot` with `available: true`.
- On any throw (e.g. `assertActive` rejects a stale runner, or `extensions` is the wrong shape): caught and degraded to `{ extensions: [], available: false }`. The catch is **independent** — a `getHooks` failure does NOT affect `getSystemPromptOptions`/`getSystemPrompt`, which have no try/catch and preserve their original throw-through-`assertActive` semantics.

### `ensureGetSystemPromptOptions()` change
The inline polyfill-addition block inside `proto.createContext` (the `runnerThis` const + two `if (typeof ctx.… !== "function")` blocks) was deleted and replaced by a single delegation call:
```ts
applyContextPolyfills(ctx as Record<string, unknown>, this as PolyfillRunner);
```
This preserves runtime behavior exactly: the same `if (typeof … !== "function")` guards run in the same order, and `this` is cast to the new `PolyfillRunner` structural type (a superset-compatible widening of the old inline anonymous type).

## TDD evidence

### RED (Step 2) — before the refactor
```
src/__tests__/sdk-patch.test.ts:
# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'applyContextPolyfills' not found in module
'…/pi-agent-ext-power-tool/src/sdk-patch.ts'.
-------------------------------
 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [8.00ms]
```
Confirmed: test fails because `applyContextPolyfills` does not yet exist.

### GREEN (Step 4) — after the refactor
```
src/__tests__/sdk-patch.test.ts:
(pass) applyContextPolyfills > installs getHooks that reads runner.extensions via collectHooks [0.18ms]
(pass) applyContextPolyfills > getHooks returns available:false if it throws (independent of getSystemPromptOptions) [0.04ms]
(pass) applyContextPolyfills > installs getSystemPromptOptions + getSystemPrompt (unchanged behavior) [0.01ms]
 3 pass
 0 fail
 6 expect() calls
Ran 3 tests across 1 file. [241.00ms]
```

## Full-suite result (Step 5) — behavior-preserving proof

```
 132 pass
 4 skip
 0 fail
 367 expect() calls
Ran 136 tests across 13 files. [283.00ms]
```
- **All pre-existing tests green.** The 4 skipped tests are the L2 e2e suite (require `PI_RUN_L2=1`, unrelated to this change).
- Output **pristine** — `grep` for `warn|error|fail|deprecat` returns only test-name false positives, ending in `0 fail`.
- **Typecheck clean:** `bun run typecheck` (`tsc --noEmit`) exits with no diagnostics, confirming the widened module augmentation and the new `PolyfillRunner` cast don't break any of the SDK consumers in `src/tools/*` or `src/index.ts`.

This proves the `getSystemPromptOptions`/`getSystemPrompt` consumers are unaffected by the extraction.

## Files changed

| File | Change |
|---|---|
| `bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts` | Modified: added import, widened module augmentation, added `PolyfillRunner` type + `applyContextPolyfills` export, replaced inline polyfill block with delegation call. (+51 / −23) |
| `bun-apps/pi-agent-ext-power-tool/src/__tests__/sdk-patch.test.ts` | New: 3 unit tests for `applyContextPolyfills`. (+47) |

`src/index.ts` and `src/tools/*` were **not** touched (verified via `git show --stat HEAD`).

## Self-review findings

- **Import placement:** Followed the brief's note — kept `import { createRequire }` at the very top and placed the new `collectHooks, type HooksSnapshot` import immediately after it (merged into the import group), rather than mid-file as the literal 3a code block's position suggested.
- **Indentation of 3b:** Matches the brief exactly (6-space indent inside `try` block).
- **`runnerThis` const:** Deleted as instructed; no dangling references.
- **Independent degradation:** The `getHooks` `try/catch` returns `{ extensions: [], available: false }`; the other two polyfills deliberately have **no** try/catch, preserving their original throw behavior. The dedicated test confirms `getSystemPromptOptions` is still installed when `assertActive` throws.
- **Module augmentation correctness:** `tsc --noEmit` clean confirms the augmented `ExtensionContext.getHooks(): HooksSnapshot` type-checks against all `import { type ExtensionContext }` call sites.
- **Scope:** Only the 2 intended files are in the commit; `.planning/…` artifacts remain untracked.

## Concerns

None. The refactor is a pure extraction + additive third polyfill; full suite + typecheck both green.
