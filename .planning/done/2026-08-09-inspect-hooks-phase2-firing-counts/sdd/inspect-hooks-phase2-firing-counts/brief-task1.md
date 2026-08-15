# Task 1 — Counting intercept + `fired` field

See ../../spec.md + ../../plan.md. Additive, backward-compatible.

## commitScope
- bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts (idempotent in-place counting-wrap in the patched createContext/applyContextPolyfills walk; WeakMap<originalFn,number> + Symbol marker)
- bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts (HookRegistration.fired; collectHooks reads counts back)
- bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.phase2.test.ts (NEW)
- .planning/<effort>/sdd/<plan>/report-task1.md (report ONLY)

## Spike-validated seam (authoritative)
SDK `emit()` (runner.js:579-588) calls `createContext()` at the top of every emit, then reads the LIVE `extension.handlers` array (no captured copy — proven by a swap-between-emits test). So replacing `ext.handlers.get(event)[i]` in-place intercepts dispatch. `on()` is NOT patchable (per-extension object literal in an unexported factory) — do NOT attempt it.

## Steps
1. Module-level `WeakMap<Function, number>` firing-counter + a Symbol wrapper marker.
2. In the patched `createContext` body (applyContextPolyfills, sdk-patch.ts): walk `runner.extensions[].handlers`; for each entry not already wrapped (Symbol check), replace the array entry IN-PLACE with `(...a) => { map.set(orig, (map.get(orig) ?? 0) + 1); return orig(...a) }` (marked with the Symbol). Idempotent.
3. `HookRegistration.fired: number`; in `collectHooks`, read `map.get(originalFn) ?? 0` per handler.
4. TDD: integration test with the REAL ExtensionRunner — register handler on an event, `runner.emit({type})` N times, `getHooks()` -> `fired === N`; never-emitted handler -> `fired === 0`; createContext/getHooks twice -> no double-count; original fn still runs on emit. Mirror the /tmp/zk-spike setup.

## Acceptance
- `fired` increments on real dispatch; idempotent; identity preserved; Phase 1 + new tests green; `fired` in JSON.
- Return SDD status (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) + the exact wrap location + any per-emit-cost note.
