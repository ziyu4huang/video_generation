# Plan — inspect_hooks Phase 2: firing counts + never-fired finding

Two TDD-sliced tasks. BASE = 0f0cdd301eb502cbfdd475eb4804818f30aaa35f. Additive, backward-compatible.

## Task 1 — Counting intercept + `fired` field in the snapshot
**commitScope:**
- bun-apps/pi-agent-ext-power-tool/src/sdk-patch.ts (idempotent in-place counting-wrap step in the patched createContext / applyContextPolyfills walk; WeakMap + Symbol)
- bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts (HookRegistration.fired; collectHooks reads counts back keyed by original fn)
- bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.phase2.test.ts (NEW — Task 1 integration tests) [or extend inspect-hooks.test.ts]
- .planning/<effort>/sdd/<plan>/report-task1.md (report ONLY)

**Steps**
1. Add a module-level `WeakMap<Function, number>` firing-counter store + a Symbol wrapper marker.
2. In the patched `createContext` body (applyContextPolyfills, sdk-patch.ts), walk `runner.extensions[].handlers`; for each entry, if not already wrapped (Symbol check), replace the array entry IN-PLACE with a wrapper that increments the WeakMap (keyed by the original fn) then calls + returns the original. Idempotent.
3. Extend `HookRegistration` (inspect-hooks.ts) with `fired: number`; in `collectHooks`, read the count back from the WeakMap (keyed by the unwrapped original) per handler; default 0.
4. TDD (integration, real ExtensionRunner): register a handler, `emit({type})` N times -> `getHooks()` asserts `fired === N`; a never-emitted handler -> `fired === 0`; getHooks/createContext twice -> no double-count; original fn still runs on emit.

**Acceptance**
- `fired` increments on real SDK dispatch (integration test via real runner).
- Idempotent (no double-wrap/double-count).
- Handler identity preserved (original invoked; readers see a callable delegating fn).
- Phase 1 tests green; new integration tests green.
- `fired` appears in JSON snapshot hook entries.

## Task 2 — `never-fired` finding + report rendering
**commitScope:**
- bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts (analyzeHooks never-fired; formatHooksReport fires column + never-fired section)
- bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts (never-fired + report pure-fn tests)
- .planning/<effort>/sdd/<plan>/report-task2.md (report ONLY)

**Steps**
1. In `analyzeHooks`, after existing findings, emit a `never-fired` finding (severity `low`) for each hook entry with `fired === 0`: message names shortPath(path) + event + registered count; detail = {path, event, count, fired:0}.
2. In `formatHooksReport`, add a "fires" column to the inventory table(s) (by-extension and by-event); add a low-severity never-fired section.
3. TDD (pure functions): analyzeHooks with a snapshot mixing fired>0 / fired===0 -> never-fired only for fired===0, correct severity/detail, none when all fired>0; formatHooksReport substring asserts for fires column + never-fired section.

**Acceptance**
- never-fired emitted ONLY for fired===0 (unit-tested).
- Report shows per-handler fires + a never-fired section.
- All existing + Task 1 tests green; package typecheck + test green.
- Additive: no Phase 1 field/finding removed/renamed.
