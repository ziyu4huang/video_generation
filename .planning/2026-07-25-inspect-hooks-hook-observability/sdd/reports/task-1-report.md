# Task 1 Report: Pure hook-analysis logic (`tools/inspect-hooks.ts` core)

## Status

**DONE** — All requirements satisfied, tests passing.

## Implementation Summary

### Files Created

1. **`bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts`** (253 lines)
   - Self-contained module with NO dependencies on `../index.js` (avoids module-init cycle)
   - Exports: `KNOWN_EVENTS`, `collectHooks`, `analyzeHooks`, `formatHooksReport`, `makeInspectHooksTool`, `Finding`, `Severity`, `summarizeFindings`
   - Duplicate types (`Severity`, `Finding`, `summarizeFindings`) are structurally identical to those in `../index.js` for JSON output consistency
   - `makeInspectHooksTool` is a placeholder (body filled in Task 3)

2. **`bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts`** (104 lines)
   - 10 test cases across 4 describe blocks
   - Tests all pure functions: `collectHooks`, `analyzeHooks`, `formatHooksReport`, `KNOWN_EVENTS`

### Core Logic Implemented

| Function | Purpose | Test Coverage |
|----------|---------|---------------|
| `collectHooks(rawExtensions: unknown): HooksSnapshot` | Maps raw `runner.extensions[]` into typed `HooksSnapshot`, tolerating shape drift | 3 tests |
| `analyzeHooks(snapshot: HooksSnapshot): Finding[]` | Analyzes hooks for unknown events, emits inventory + stats | 4 tests |
| `formatHooksReport(snapshot, findings, byEvent): string` | Renders severity-ranked text report | 2 tests |
| `KNOWN_EVENTS: ReadonlySet<string>` | All pi 0.82.0 lifecycle events for unknown-event detection | 1 test |

## TDD Evidence

### RED Phase (Expected Failure)

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```

**Output:**
```
bun test v1.3.14 (0d9b296a)

src/tools/__tests__/inspect-hooks.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../inspect-hooks.js' from '/Users/huangziyu/proj/video_generation__tool_gate/bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts'
-------------------------------

 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [10.00ms]
```

**Why expected:** Module `../inspect-hooks.js` does not exist yet.

---

### GREEN Phase (All Tests Passing)

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```

**Output (first run):**
```
bun test v1.3.14 (0d9b296a)

src/tools/__tests__/inspect-hooks.test.ts:
(pass) collectHooks > maps runner.extensions[] (Map<event,handler[]>) into ExtensionHooks[] [0.11ms]
(pass) collectHooks > returns available:false when input is not an array (SDK shape changed) [0.01ms]
(pass) collectHooks > tolerates a missing handlers map / missing path [0.03ms]
(pass) analyzeHooks > flags handler on an UNKNOWN event as medium unknown-event-name [2.64ms]
(pass) analyzeHooks > does NOT flag a real event [0.21ms]
(pass) analyzeHooks > emits per-extension inventory (info) + stats (info) [0.07ms]
(pass) analyzeHooks > available:false → only a hooks-unavailable info finding [0.03ms]
(pass) formatHooksReport > text report includes the unknown-event message + inventory line [0.24ms]
(pass) formatHooksReport > byEvent=true groups the inventory by event [0.04ms]
(pass) KNOWN_EVENTS > includes the high-frequency events (sanity vs SDK drift) [0.02ms]

 10 pass
 0 fail
 24 expect() calls
Ran 10 tests across 1 file. [297.00ms]
```

**Output (second run for stability):**
```
bun test v1.3.14 (0d9b296a)

src/tools/__tests__/inspect-hooks.test.ts:
(pass) collectHooks > maps runner.extensions[] (Map<event,handler[]>) into ExtensionHooks[] [0.10ms]
(pass) collectHooks > returns available:false when input is not an array (SDK shape changed) [1.45ms]
(pass) collectHooks > tolerates a missing handlers map / missing path [0.10ms]
(pass) analyzeHooks > flags handler on an UNKNOWN event as medium unknown-event-name [0.15ms]
(pass) analyzeHooks > does NOT flag a real event [0.04ms]
(pass) analyzeHooks > emits per-extension inventory (info) + stats (info) [0.03ms]
(pass) analyzeHooks > available:false → only a hooks-unavailable info finding [0.01ms]
(pass) formatHooksReport > text report includes the unknown-event message + inventory line [0.15ms]
(pass) formatHooksReport > byEvent=true groups the inventory by event [0.03ms]
(pass) KNOWN_EVENTS > includes the high-frequency events (sanity vs SDK drift) [0.02ms]

 10 pass
 0 fail
 24 expect() calls
Ran 10 tests across 1 file. [243.00ms]
```

**Result:** All 10 tests passing consistently. Output is pristine — no warnings, no errors, no console.log noise.

## Commit

```
commit e32911a596d70791543f5ce6dd9d1d1f2842904a
Author: Ziyu Huang <ziyu4huang@gmail.com>
Date:   2026-07-25 06:14:27 +0800

    feat(power-tool): add inspect_hooks pure analysis logic (collectHooks/analyzeHooks/formatHooksReport)

 .../src/tools/__tests__/inspect-hooks.test.ts      | 104 +++++++++
 .../src/tools/inspect-hooks.ts                     | 253 +++++++++++++++++++++
 2 files changed, 357 insertions(+)
```

## Self-Review Findings

### ✅ Completeness

- All required exports present: `KNOWN_EVENTS`, `HooksSnapshot`, `collectHooks`, `analyzeHooks`, `formatHooksReport`, `makeInspectHooksTool`, `Finding`, `Severity`, `summarizeFindings`
- Header comment accurately describes purpose and self-contained nature
- `KNOWN_EVENTS` includes all pi 0.82.0 lifecycle events

### ✅ Quality

- Code transcribed verbatim from brief (minus omitted trailing lines as instructed)
- Type annotations complete
- Error handling for shape drift (`collectHooks` returns `available: false` when input is not array)
- Path shortening logic (`shortPath`) preserves `bun-apps/` prefix where possible

### ✅ YAGNI

- No SDK runtime involvement (that's Task 2)
- No actual `execute()` implementation in `makeInspectHooksTool` (that's Task 3)
- No wiring into extension registration (that's Task 4)
- Pure functions only, no side effects

### ✅ Tests Verify Real Behavior

- `collectHooks` tests verify Map → Array transformation, missing fields tolerance, and `available: false` on non-array input
- `analyzeHooks` tests verify unknown-event detection, real-event acceptance, inventory/stats emission, and unavailable case
- `formatHooksReport` tests verify text contains expected content and byEvent grouping
- `KNOWN_EVENTS` test validates sanity vs SDK drift

### ✅ Output Pristine

- No `console.log` or debug statements
- Test runner output clean: only `bun test` header + passing tests
- No warnings or errors

## Concerns

**None.** The implementation is straightforward pure logic with no external dependencies beyond the SDK and typebox. The module is self-contained as required, avoiding any module-init cycle with `../index.js`.

## Files Changed

- `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts` (created)
- `bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts` (created)

## Next Steps

Task 1 is complete. Task 2 will add the SDK context polyfill (`getHooks()`) via `src/sdk-patch.ts`.
