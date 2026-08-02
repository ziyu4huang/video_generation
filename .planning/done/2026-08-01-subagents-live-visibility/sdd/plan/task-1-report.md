# Task 1 Report — Batch tool forwards live callbacks + sets `batchId`

**Task:** `zk-spawn` (Task 1 of the *subagents live-visibility* effort)
**Commit:** `b9d61db9` — `feat(subagents): forward per-child live callbacks + set batchId on in-flight entries`

## What I implemented

Closed **deficit 1** (the `subagents` batch tool registered each in-flight child with a static row but never forwarded the per-child `onModelResolved`/`onHistory` callbacks, so children showed no resolved model and no activity trace) **and** added the `batchId` correlation field that Task 2's viewer grouping will consume.

Three production changes, in the 2 named source files only:

1. **`src/subagent-in-flight.ts`** — added the optional `batchId?: string` field to `InFlightSubagent` (placed after `resolvedModel`, with a doc comment noting it is set only on batch-tool children; undefined for singular `subagent` dispatches and workflow agents → backward compatible). It is OPTIONAL, so the shared singleton registry stays usable by every consumer.

2. **`src/subagents-tool.ts`** — inside `execute()`'s `runWithConcurrency` callback:
   - Added `batchId: toolCallId` to the `inFlight.start({…})` call (the **only** place `batchId` is set, per the constraint).
   - Built a new `childSpawnOpts: SpawnSubagentOptions` that spreads `childOpts` (the `mergeReadOnlyExclusion` output) and adds the two live callbacks, then calls `spawn(childSpawnOpts)` instead of `spawn(childOpts)`.
   - `onModelResolved: (id) => options.inFlight?.updateModel(childRunId, id)` — routes the child's resolved model into the registry entry.
   - `onHistory: (history) => options.inFlight?.update(childRunId, history)` — NO explicit param type, NO `AgentHistoryEntry` import; the element type is inferred from `SpawnSubagentOptions.onHistory` (per the ambiguity resolution). `update()` already accepts `AgentHistoryEntry[]`, which matches.

   The callbacks are spread **at the call site** (where `options.inFlight` and `childRunId` are in scope), NOT inside `mergeReadOnlyExclusion` — which is a pure helper with no access to the registry or the run id.

The `try { … } finally { options.inFlight?.end(childRunId); }` cleanup is unchanged, so the registry still never leaks a run.

## TDD evidence (RED → GREEN)

### Steps 1–4: in-flight carries `batchId`

**Step 1** — appended the test to `tests/subagent-in-flight.test.ts`:
```ts
test("start carries batchId through for batch-tool children; undefined for singular-tool runs", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "batch-1" });
  assert.equal(reg.get("c0")?.batchId, "batch-1");
  reg.start({ id: "solo", model: "y", taskPreview: "u", startedAt: 0 });
  assert.equal(reg.get("solo")?.batchId, undefined);
});
```

**Step 2 — RED.** The brief's expected failure is a *TypeScript* error (`batchId does not exist on type 'InFlightSubagent'`). The package's `bun test` strips types (no type-check), and the package `tsconfig.json` only includes `src/**` (not `tests/`), so neither the project `bun test` nor the project `tsc --noEmit` surface the type error. To demonstrate the true RED I type-checked the test file directly against the source:

```
$ bunx tsc --noEmit --strict --module nodenext --moduleResolution nodenext \
    --target es2022 --types bun --lib esnext,dom --skipLibCheck \
    tests/subagent-in-flight.test.ts src/subagent-in-flight.ts --ignoreConfig
tests/subagent-in-flight.test.ts(70,69): error TS2353: Object literal may only specify known properties, and 'batchId' does not exist in type 'InFlightSubagent'.
tests/subagent-in-flight.test.ts(71,31): error TS2339: Property 'batchId' does not exist on type 'InFlightSubagent'.
tests/subagent-in-flight.test.ts(74,33): error TS2339: Property 'batchId' does not exist on type 'InFlightSubagent'.
```

**Step 3** — added `batchId?: string` (with doc comment) to `InFlightSubagent`.

**Step 4 — GREEN:**
```
$ bun test tests/subagent-in-flight.test.ts
tests/subagent-in-flight.test.ts:
(pass) start carries batchId through for batch-tool children; undefined for singular-tool runs [0.01ms]
 6 pass, 0 fail
```
and the direct test-file type-check is now clean.

### Steps 5–8: batch tool sets `batchId` + forwards callbacks

**Step 5** — appended the capture-the-registry-mid-run test to `tests/subagents-tool.test.ts` (verbatim from the brief).

**Step 6 — RED:**
```
$ bun test tests/subagents-tool.test.ts -t "batch children get batchId"
AssertionError: child registered with the batch toolCallId as batchId
+ actual - expected
+ undefined
- 'batch-call'
 0 pass, 14 filtered out, 1 fail
```
(`batchId` undefined because the callbacks were not forwarded and `batchId` not yet set.)

**Step 7** — implemented both edits in `src/subagents-tool.ts` (see "What I implemented").

**Step 8 — GREEN:**
```
$ bun test tests/subagents-tool.test.ts
(pass) batch children get batchId + forwarded onModelResolved/onHistory update the registry [0.12ms]
 15 pass, 0 fail
```

## Full-suite + type-check (run before commit)

```
$ bun test                                # full pi-agent-ext-subagent suite
 366 pass, 0 fail, 145 expect() calls
Ran 366 tests across 33 files. [964.00ms]

$ bunx tsc --noEmit                        # project tsconfig (src only)
tsc src: clean (exit 0)
```

## Files changed (exactly the 4 named in the brief)

```
 M bun-apps/pi-agent-ext-subagent/src/subagent-in-flight.ts
 M bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts
 M bun-apps/pi-agent-ext-subagent/tests/subagent-in-flight.test.ts
 M bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts
```
4 files changed, 60 insertions(+), 1 deletion(-). No other files touched (viewer, singular `subagent` tool, config — all untouched).

## Self-review

- **Completeness** — all 9 brief steps executed in order; both deficits addressed (forwarded callbacks **and** `batchId` correlation field for Task 2).
- **Quality** — `batchId` field has a doc comment explaining its purpose and backward-compat guarantees; callbacks spread at the call site exactly as the brief mandates (the pure helper `mergeReadOnlyExclusion` is untouched); `onHistory` has no explicit param type and no `AgentHistoryEntry` import (inference, per the ambiguity resolution). `AgentHistoryEntry[]` flows correctly: `SpawnSubagentOptions.onHistory`'s parameter type is inferred onto `history`, then passed to `SubagentInFlightRegistry.update(id, AgentHistoryEntry[])` — type-compatible, confirmed by the clean test-file type-check.
- **YAGNI** — only what was needed: one optional field, two callbacks, one new opts object. No extra registry methods, no required-field promotion, no viewer changes.
- **Test hygiene** — both new tests are deterministic (`concurrency: 1`, fixed task order); the in-flight test covers both the batch-tool child (sets `batchId`) and the singular-tool child (omits it → undefined) for backward-compat; the batch-tool test asserts registry is empty after completion (no leak) and checks both forwarded callbacks took effect plus the `batchId` value.
- **Pristine output** — 366/366 pass, `tsc --noEmit` exit 0, no stray files, only the 4 named files staged.

## Concerns

- **Process note (not a defect):** the project `tsconfig.json` includes only `src/**`, and `bun test` strips types, so the Step 2 "RED" cannot be observed through the normal `bun test` / project `tsc --noEmit` commands. I demonstrated the genuine type-level RED by invoking `tsc` directly on the test file with explicit flags (output quoted above). The GREEN for both `tsc` (src, project config) and the full test suite is real and reproducible via the standard commands. If a future task wants RED to be observable in-repo, the test files would need to be included in a type-check config — but that is out of scope for this task.
- No behavioral concerns. `batchId` is optional everywhere except the one batch-tool call site, so the singular `subagent` tool and the workflow path are unaffected (verified by the full 366-test suite, which includes their tests).
