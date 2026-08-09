# Report — Task 1: Counting intercept + `fired` field

**Status:** DONE

## What landed
- `inspect-hooks.ts`: module-level `WeakMap<Function, number>` (`hookFiringCounts`, keyed by ORIGINAL handler fn) + two Symbols (`kWrapped`, `kOrig`). New exports `wrapHookHandlers(extensions)` (idempotent in-place counting wrap) and `getHookFiringCount(handler)` (unwraps via Symbols → reads the WeakMap, default 0). `HookRegistration` gained `fired: number`. `collectHooks` sums per-handler fires into `fired` (per event).
- `sdk-patch.ts`: `applyContextPolyfills` now calls `wrapHookHandlers(runner.extensions)` on every `createContext`/emit — the SDK `emit()` runs `createContext()` at the top of every emit (runner.js:578) THEN reads the live `extension.handlers` array (no captured copy), so the wrap lands before dispatch on the first emit.
- `inspect-hooks.phase2.test.ts` (NEW): real-`ExtensionRunner` integration tests + pure unit guards.

## Wrap location
`wrapHookHandlers()` lives in `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts` (the reader module, to keep sdk-patch→inspect-hooks import direction — no cycle); it is INVOKED from `applyContextPolyfills()` in `sdk-patch.ts` (appended at the tail of that fn, after the getHooks install). The counter store + Symbols live next to it in inspect-hooks.ts.

## Counter store
`WeakMap<Function, number>` keyed by the ORIGINAL handler fn. The wrapper closes over `orig`, increments `hookFiringCounts.get(orig)`, marks itself with `kWrapped` and stores `orig` under `kOrig`. `getHookFiringCount(handler)` recovers the orig: if the live-array entry has `kWrapped`, read `handler[kOrig]`; otherwise the entry IS the orig (never wrapped / read before first emit). Then `hookFiringCounts.get(orig) ?? 0`. Handles both wrapped and unwrapped (orig-only) entries → `fired: 0` before first emit.

## Test fidelity
**real-ExtensionRunner.** Tests construct a real `ExtensionRunner`, register a handler, `await runner.emit({type})` N times, then `collectHooks` → `fired === N`. The dispatch path (emit → createContext [patched] → wrap → live handlers array) is 100% real SDK code. Caveat: the SDK's `loadExtensionFromFactory` is NOT re-exported through the package root and the package `exports` map blocks deep imports, so registration uses a faithful mirror of the SDK's `createExtensionAPI.on()` (assertActive + push to the handlers Map) against a real `createExtensionRuntime()`. A direct-wrap fallback test also exercises `wrapHookHandlers`/`collectHooks` in isolation.

## Verification
- `bun run --cwd bun-apps/pi-agent-ext-power-tool typecheck` → **pass** (clean).
- `bun run --cwd bun-apps/pi-agent-ext-power-tool test` → **pass**: 154 pass / 0 fail / 4 skip (skips are unrelated L2 e2e gated by `PI_RUN_L2=1`).
- New Phase 2 file: **8 pass / 0 fail** (5 real-runner integration + 3 pure unit).
- Phase 1 tests: **green** (intent unchanged).

## Per-emit cost
One `typeof` check + one Symbol read per handler per emit (createContext is on the hot emit path). Negligible for tens of handlers; wrap is a no-op once all handlers carry `kWrapped`.

## Idempotency
`kWrapped` Symbol guard skips already-wrapped entries, so repeated createContext walks never double-wrap or double-count. Verified by an explicit test (emit twice + two `getHooks` reads → `fired === 2`, single wrapper in the array).

## Scope note (necessary additive test edits)
The additive `fired: number` on `HookRegistration` is a required field, so every hand-built snapshot literal that is type-checked against `HooksSnapshot`/`HookRegistration` needed `fired: 0`. That touched two Phase-1 test files outside the brief's literal 3-path commit list:
- `inspect-hooks.test.ts` (6 hand-built snapshot literals + the tool `return_json` toEqual)
- `sdk-patch.test.ts` (1 getHooks toEqual)
- `inspect-hooks.ts` self_test mock (2 literals)
All edits are purely additive (`fired: 0` appended); no field/finding removed or renamed; Phase 1 test intent unchanged. Without these, typecheck/strict-toEqual would break on main. `MEMORY.md` was NOT touched/committed.

## Acceptance
- [x] `fired` increments on real SDK dispatch (integration via real runner)
- [x] idempotent (no double-wrap/double-count)
- [x] handler identity preserved (orig invoked; live-array readers see a callable delegating fn)
- [x] Phase 1 tests green; new integration tests green
- [x] `fired` appears in JSON snapshot hook entries

**Concerns:** none.
