# Task 1 Report: Registry — hold + invalidate on resolved model

## What I Implemented

Added the foundation for tracking resolved models in the `SubagentInFlightRegistry`:

1. **Extended `InFlightSubagent` interface** with two new optional fields:
   - `resolvedModel?: string` - stores the concrete provider/id once the child resolves its model via `onModelResolved`
   - `invalidate?: () => void` - a re-render callback that will be bound by the tool's `renderCall`

2. **Added three methods to `SubagentInFlightRegistry`**:
   - `get(id: string): InFlightSubagent | undefined` - returns the live entry by id
   - `bindInvalidate(id: string, invalidate: () => void): void` - binds the harness invalidate callback for a run
   - `updateModel(id: string, model: string): void` - records the concrete resolved model and triggers the bound invalidate callback; no-op if the run doesn't exist or has already ended

## TDD Evidence

### RED - Failing Tests

**Command:**
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )
```

**Failing Output:**
```
tests/subagent-in-flight.test.ts:
(pass) registry start/list/end lifecycle [0.54ms]
(pass) registry update streams history into the live entry; updates after end are no-ops [0.04ms]
32 |   assert.equal(reg.list().length, 0);
33 | });
34 | 
35 | test("get returns the live entry by id", () => {
36 |   const reg = new SubagentInFlightRegistry();
37 |   assert.equal(reg.get("missing"), undefined);
                        ^
TypeError: reg.get is not a function. (In 'reg.get("missing")', 'reg.get' is undefined)
      at <anonymous> (/Users/huangziyu/proj/video_generation__subagent/bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts:37:20)
(fail) get returns the live entry by id [0.12ms]
41 | 
42 | test("updateModel records resolvedModel and triggers the bound invalidate", () => {
43 |   const reg = new SubagentInFlightRegistry();
44 |   let invalidated = 0;
45 |   reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
46 |   reg.bindInvalidate("a", () => { invalidated++; });
           ^
TypeError: reg.bindInvalidate is not a function. (In 'reg.bindInvalidate("a", () => {
    invalidated++;
  })', 'reg.bindInvalidate' is undefined)
      at <anonymous> (/Users/huangziyu/proj/video_generation__subagent/bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts:46:7)
(fail) updateModel records resolvedModel and triggers the bound invalidate [0.04ms]
50 | });
51 | 
52 | test("updateModel on an unknown or ended id is a no-op", () => {
53 |   const reg = new SubagentInFlightRegistry();
54 |   let invalidated = 0;
55 |   reg.updateModel("ghost", "x/y"); // unknown id — no throw, no invalidate
           ^
TypeError: reg.updateModel is not a function. (In 'reg.updateModel("ghost", "x/y")', 'reg.updateModel' is undefined)
      at <anonymous> (/Users/huangziyu/proj/video_generation__subagent/bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts:55:7)
(fail) updateModel on an unknown or ended id is a no-op [0.03ms]

 2 pass
 3 fail
Ran 5 tests across 1 file. [15.00ms]
```

**Why Expected:** The three new methods (`get`, `bindInvalidate`, `updateModel`) did not exist yet, and the `resolvedModel` field was not part of the interface.

### GREEN - Passing Tests

**Command:**
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-in-flight.test.ts )
```

**Passing Output:**
```
bun test v1.3.14 (0d9b296a)

tests/subagent-in-flight.test.ts:
(pass) registry start/list/end lifecycle [0.66ms]
(pass) registry update streams history into the live entry; updates after end are no-ops [0.04ms]
(pass) get returns the live entry by id [0.01ms]
(pass) updateModel records resolvedModel and triggers the bound invalidate [0.03ms]
(pass) updateModel on an unknown or ended id is a no-op [0.02ms]

 5 pass
 0 fail
Ran 5 tests across 1 file. [12.00ms]
```

**Full Package Suite:**
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test )
```

```
207 pass
0 fail
5 expect() calls
Ran 207 tests across 15 files. [694.00ms]
```

All tests pass, including the 3 new tests and all 207 package tests without regressions.

## Files Changed

1. `bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts` (24 lines added)
   - Extended `InFlightSubagent` interface with `resolvedModel?` and `invalidate?` fields
   - Added `get()`, `bindInvalidate()`, and `updateModel()` methods to `SubagentInFlightRegistry`

2. `bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts` (29 lines added)
   - Added 3 new tests covering the new functionality

## Self-Review Findings

The implementation follows the brief exactly:
- Interface extensions match the specification verbatim
- Method implementations are correctly placed (after `update`, before `end`)
- `get()` returns the live entry or `undefined` for missing ids
- `bindInvalidate()` only sets the callback if the run exists
- `updateModel()` safely handles unknown/ended ids (no-op) and calls the bound invalidate after setting the resolved model
- Tests cover all edge cases: missing ids, unknown ids, ended runs, and the happy path

No concerns - the implementation is clean, minimal, and well-tested.

## Commit

```
61cad472 feat(subagent): registry holds resolvedModel + drives call-line invalidate
```

## Concerns

None. The implementation is straightforward and all tests pass.
