# Task 2 Report: renderSubagentCall — the resolved-model segment

## Implementation Summary

Added support for displaying the resolved model id as a separate segment in the subagent call line during execution. The `renderSubagentCall` function now accepts an optional `resolvedModel?: string` parameter and appends it as a themed segment when:

1. `resolvedModel` is provided (not undefined)
2. `resolvedModel` differs from the requested-model slot (to avoid duplication when an explicit model resolves to itself)

This allows the TUI to show the concrete model being used (e.g., `google/gemma-4-12b-qat`) while keeping the requested tier/model (e.g., `tier:medium`) visible for transparency.

## TDD Evidence

### RED Phase (Failing Tests)

**Command:**
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )
```

**Relevant Failing Output:**
```
558 | test("renderSubagentCall appends resolved model as a separate segment when tier is shown", () => {
559 |   const out = renderSubagentCall(
560 |     { agent: "auditor", tier: "medium", task: "x", resolvedModel: "google/gemma-4-12b-qat" },
561 |     T,
562 |   );
563 |   assert.match(out, /tier:medium ▸ google\/gemma-4-12b-qat ▸/);
               ^
AssertionError: The input did not match the regular expression /tier:medium \u25B8 google\/gemma-4-12b-qat \u25B8/. Input:

'subagent ▸ auditor ▸ tier:medium ▸ "x"'

      at internalMatch (node:assert:561:55)
      at match (node:assert:565:16)
      at <anonymous> (/Users/huangziyu/proj/video_generation__subagent/bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts:563:10)
(fail) renderSubagentCall appends resolved model as a separate segment when tier is shown [0.71ms]
```

**Why Expected:**
The test failed because the existing `renderSubagentCall` implementation did not accept or process a `resolvedModel` parameter. The output was `'subagent ▸ auditor ▸ tier:medium ▸ "x"'` but the test expected the resolved model segment `▸ google/gemma-4-12b-qat` to appear between the tier and the task. This is the correct failing behavior before implementing the feature.

### GREEN Phase (Passing Tests)

**Command:**
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )
```

**Passing Output (excerpt):**
```
(pass) renderSubagentCall shows subagent ▸ agent ▸ model ▸ task (omits agent when absent) [0.04ms]
(pass) renderSubagentCall shows 'tier:small' in the model slot when model is omitted [0.02ms]
(pass) renderSubagentCall appends resolved model as a separate segment when tier is shown [0.02ms]
(pass) renderSubagentCall omits resolved model before resolution (undefined) [0.01ms]
(pass) renderSubagentCall omits resolved model when it equals the explicit model slot (no dup) [0.01ms]
...
 77 pass
 0 fail
```

**Full Package Suite:**
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test )
```

**Result:**
```
 210 pass
 0 fail
 5 expect() calls
Ran 210 tests across 15 files. [693.00ms]
```

All 77 tests in `subagent-tool.test.ts` pass, including the 3 new tests. All 210 tests across the entire package also pass, confirming no regressions.

## Files Changed

1. **bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts**
   - Updated `renderSubagentCall` function signature to accept `resolvedModel?: string`
   - Added logic to append resolved model as a separate segment when it differs from the requested-model slot
   - Added inline comments explaining the behavior

2. **bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts**
   - Added 3 new tests for `renderSubagentCall`:
     - `renderSubagentCall appends resolved model as a separate segment when tier is shown`
     - `renderSubagentCall omits resolved model before resolution (undefined)`
     - `renderSubagentCall omits resolved model when it equals the explicit model slot (no dup)`

## Self-Review Findings

### Positive Aspects
- ✅ Implementation matches the brief exactly
- ✅ TDD process followed correctly: RED → GREEN → full suite check
- ✅ All existing tests continue to pass (no regressions)
- ✅ New tests cover all three important scenarios:
  - Resolved model shown when tier is used
  - Resolved model omitted when undefined
  - Resolved model omitted when it equals explicit model (no duplication)
- ✅ Code is clean, well-commented, and follows existing style
- ✅ The function signature change is backward-compatible (`resolvedModel` is optional)

### Design Decisions
- The implementation correctly uses the "slot" concept (explicit model → tier → default) for comparison
- The segment is appended with the same `muted` theme color as the slot, maintaining visual consistency
- The conditional check `args.resolvedModel && args.resolvedModel !== slot` cleanly handles both the undefined case and the deduplication case

### Areas Handled Correctly
- The brief explicitly states this task touches ONLY `renderSubagentCall` and the tests
- No changes were made to `subagent-in-flight.ts` (Task 1's work)
- No changes were made to tool-def `renderCall`/`execute` (Task 3's work)
- Commit message matches the brief exactly
- Only the two specified files were committed

## Concerns

None. The implementation is complete, correct, and well-tested. The TDD cycle completed successfully with all tests passing.

## Commit

**SHA:** `5dc3d32f`
**Subject:** `feat(subagent): renderSubagentCall shows resolved model as a segment`

## Test Summary

3 new tests added, all passing. Total: 77 tests in subagent-tool.test.ts, 210 tests across the package (15 files).
