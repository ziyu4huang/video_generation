# Spec — inspect_hooks Phase 2: firing counts + never-fired finding

## Problem Statement
inspect_hooks (pi-agent-ext-power-tool) Phase 1 lists registered hooks read-only (event names + handler counts + unknown-event-name findings). It cannot tell which registered hooks actually FIRE during a session — so a handler on a typo'd event, or a dead/broken registration, is indistinguishable from a healthy hot handler. Developers debugging "why isn't my hook running?" get no signal. Phase 2 adds firing-count observability: count each handler's real invocations and surface registered-but-never-fired handlers.

## Solution
Wrap each registered hook handler with an idempotent counting wrapper, installed in-place on the live `extension.handlers` array via the existing `createContext` polyfill that Phase 1 already owns. The SDK `emit()` (runner.js:579-588) calls `createContext()` then reads the live handlers array at fire time (spike-verified against SDK 0.84.1), so the wrapper increments on every real dispatch starting at the session's first emit. inspect_hooks then reports per-handler `fired` counts and emits a `never-fired` finding for handlers with `fired === 0`. Additive + backward-compatible (new field + new finding check; existing output unchanged).

## User Stories
1. As an extension author, I want to see how many times each registered hook actually fired, so I can confirm my handler is wired and invoked.
2. As an extension author, I want inspect_hooks to flag handlers that registered but never fired, so I can catch dead/broken registrations that Phase 1's unknown-event check misses (e.g. a valid event name with a never-invoked handler).
3. As a maintainer, I want Phase 2 to be additive and backward-compatible, so existing JSON consumers (e.g. extension-auditor) don't break.

## Implementation Decisions
- **Intercept seam**: in the patched `createContext` body (`applyContextPolyfills` in src/sdk-patch.ts), walk `runner.extensions[].handlers` and replace each UNWRAPPED handler entry IN-PLACE with a counting wrapper. `emit()` runs `createContext()` at the top of every emit before iterating handlers, so the wrap installs before handlers run on the first emit. Spike-verified.
- **Idempotency**: a Symbol marker on the wrapper so repeated createContext walks never double-wrap or double-count.
- **Counter storage**: module-level `WeakMap<originalFn, number>`; the wrapper closure increments it; `collectHooks` (src/tools/inspect-hooks.ts) reads it back keyed by the original fn (unwrapped via the Symbol). Handler identity preserved (other readers of `extension.handlers` still see a callable fn delegating to the original).
- **Observation window**: since the session's first emit. No explicit reset; counts accumulate over the process/session lifetime. All handlers caught regardless of extension load-order (createContext walk sees all extensions at emit time).
- **HookRegistration**: add `fired: number` (default 0).
- **never-fired finding**: in `analyzeHooks`, emit `never-fired` (severity `low`) for each hook entry with `fired === 0`. Low because rare events legitimately never fire in a short session — a hint, not an error.
- **Report**: add a "fires" column to the inventory table(s) in `formatHooksReport`; surface never-fired findings in a dedicated low-severity section. JSON gains `fired` on each hook entry + `never-fired` entries in `findings`. Additive — no existing field/finding removed or renamed.
- **Backward compat**: extend, don't break.

## Testing Decisions
- **Task 1 (intercept mechanism)**: integration tests using the REAL `ExtensionRunner` (the spike proved this path): register a handler, `runner.emit({type})` N times, then `getHooks()` -> assert `fired === N`; a handler registered but never emitted -> `fired === 0`; idempotency (getHooks/createContext twice -> no double-count); the original fn still actually runs when emitted (wrapper delegates). Location: new `src/tools/__tests__/inspect-hooks.phase2.test.ts` (or extend inspect-hooks.test.ts).
- **Task 2 (never-fired + report)**: pure-function tests on `analyzeHooks` with a hand-built snapshot mixing `fired>0` and `fired===0` -> assert `never-fired` findings only for `fired===0`, correct severity/detail, and none when all `fired>0`; `formatHooksReport` substring assertions for the fires column + never-fired section.
- Existing Phase 1 tests stay green (additive).
- Prior art: the /tmp/zk-spike swap-between-emits proof is the reference for the Task 1 integration test setup.

## Out of Scope
- Patching the SDK `on()`/registration API (spike: not patchable; in-place wrap is strictly better).
- Cross-session persistence of counts (in-process, session-scoped).
- Last-fired timestamps (low value for v1).
- Tool-input controls for reset/observation-window (window fixed: since first emit).
- Changes to Phase 1 findings/output (additive only).

## Further Notes
- Per-emit cost: one Symbol check per handler per emit (tens of handlers) — negligible, but createContext is on the hot emit path; keep the wrap step cheap.
- never-fired accuracy depends on the SDK always dispatching via `emit*`/`createContext`; SDK 0.84.1 has no other dispatch path (spike-verified). A future off-path dispatch would undercount — acceptable for v1.
- Counter keyed by the ORIGINAL fn (WeakMap) so the wrapper in the array doesn't break identity/lookup.
