# Task 3 Report — Wire onModelResolved + renderCall to the registry

## What I implemented

Wired Task 1's `SubagentInFlightRegistry` (resolved-model + invalidate plumbing)
to Task 2's `renderSubagentCall(..., resolvedModel)` segment, inside
`src/subagent-tool.ts`, so the live call line updates to
`subagent ▸ auditor ▸ tier:medium ▸ google/gemma-4-12b-qat ▸ "task"` once the
child resolves its model.

Two edits (content-anchored, verbatim from the brief):

1. **`execute` → `onModelResolved`** (~line 520): added
   `options.inFlight?.updateModel(toolCallId, id);` so the registry records the
   resolved model and (if `renderCall` already bound an `invalidate`) forces a
   call-line re-render immediately.
2. **tool-def `renderCall`** (~line 613): reads
   `options.inFlight?.get(context.toolCallId)?.resolvedModel`, binds
   `options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate)`,
   and spreads `resolvedModel` into
   `renderSubagentCall({ ...args, resolvedModel }, theme)`.

## TDD evidence

### RED (before source edits)

Test 1 — onModelResolved wiring:
```
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "threads onModelResolved" )
```
```
AssertionError: Expected values to be strictly deep-equal:
+ actual - expected
+ []
- [ [ 'tc1', 'google/gemma-4-12b-qat' ] ]
```
Expected: `updates` is empty because `onModelResolved` did not call
`registry.updateModel`. ✓ correct reason.

Test 2 — renderCall wiring (after adapting `getText()` → field read, see
Concerns): 
```
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts -t "renderCall reads resolvedModel" )
```
```
AssertionError: The input did not match the regular expression
/tier:medium ▸ google\/gemma-4-12b-qat ▸/. Input:
'subagent ▸ auditor ▸ tier:medium ▸ "x"'
```
Expected: renderCall ignored the registry (no model segment), and
`invalidate` was not bound. ✓ correct reason.

### GREEN (after both source edits)

```
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )
 79 pass
 0 fail
```
Both new tests pass:
```
(pass) execute threads onModelResolved into registry.updateModel (live resolved model)
(pass) renderCall reads resolvedModel from the registry and binds invalidate
```

### Whole-package suite (regression check)

```
( cd bun-apps/pi-agent-ext-subagent && bun test )
 212 pass
 0 fail
 5 expect() calls
 Ran 212 tests across 15 files.
```
No regressions — Task 1's `subagent-in-flight.test.ts` and Task 2's
`renderSubagentCall` segment tests still pass.

## Files changed

- `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (+9/-2) — the two
  wiring edits above, verbatim from the brief.
- `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts` (+44/-2):
  - added `import { Text } from "@earendil-works/pi-tui";`
  - appended the 2 new tests (adapted for biome + the `Text` API — see
    Concerns), preserving the brief's assertion content exactly
    (`/tier:medium ▸ google\/gemma-4-12b-qat ▸/`).
  - incidentally reformatted one pre-existing Task 2 line (the
    `renderSubagentCall(... resolvedModel: "x/flash" ...)` no-dup test) that
    biome flagged as non-conforming in the same file — whitespace only, no
    logic change.

Commit: `ecd6fecf` — `feat(subagent): wire resolved model into the live call
line`. Exactly the two files staged explicitly (no `git add -A`); nothing under
`.planning/` committed.

## Self-review findings

- **Spec coverage:** WHERE (call line) → Tasks 2+3; FORMAT (tier ▸ full model ▸
  task) → Task 2; pre-resolution behavior (omit when undefined) → Task 2;
  feasibility → exercised by the 2 new wiring tests. ✓
- **Type consistency:** `resolvedModel?: string` flows identically through
  `InFlightSubagent` (Task 1) → `registry.get(...).resolvedModel` (Task 3) →
  `renderSubagentCall` arg (Task 2). `get`/`bindInvalidate`/`updateModel`
  signatures match producer (Task 1) and consumer (Task 3). ✓
- **Source edits are verbatim** to the brief (only the 2 lines + 6 lines added;
  no drift). ✓
- **Biome:** `subagent-tool.test.ts` is now fully biome-clean. The only
  remaining `bun run check` failure is `tests/subagent-in-flight.test.ts`
  (Task 1 pre-existing format debt, separate file, out of scope). See Concerns.

## Concerns

1. **Brief defect: `Text` has no `getText()`.** The brief (and the task header)
   instruct reading the call line back via `text.getText()`. No version of
   `@earendil-works/pi-tui` (checked 0.80.6 / 0.80.7 / 0.80.10 / 0.81.1 /
   0.82.0) exposes a `getText()` method — the `Text` class stores its content in
   a TS-`private text` field written by `setText()`. Used verbatim, the test
   throws `TypeError: text.getText is not a function` and fails for the WRONG
   reason (not the intended "no model segment" assertion). I adapted minimally
   and faithfully: read the same field via
   `(text as unknown as { text: string }).text`, preserving the brief's
   assertion content exactly. This makes the RED failure be the intended
   assertion mismatch, matching the brief's stated RED expectation. Flagging
   for awareness; a future pi-tui release adding a public `getText()` would let
   us drop the cast.

2. **Brief test code does not conform to biome.** The brief's verbatim test
   bodies (inline arrow `{ ... }` blocks, `tool.renderCall!(...)` non-null
   assertion, multi-line arg formatting) trip the project's biome rules
   (`style/noNonNullAssertion`, formatter). I conformed my additions to biome:
   `tool.renderCall!` → `tool.renderCall?.` (safe — `renderCall` is always
   defined on the tool, and the test still meaningfully verifies the wiring
   because a skipped call would leave `invalidated === 0` and fail the later
   assert), and reformatted the inline bodies. Test logic is unchanged.

3. **Pre-existing lint debt (out of scope, not introduced here):**
   - `tests/subagent-in-flight.test.ts` format (Task 1, `61cad47`) — separate
     file, left untouched (the source `subagent-in-flight.ts` is explicitly
     off-limits and I extended that courtesy to its test file).
   - One Task 2 line in `subagent-tool.test.ts` (`5dc3d32`) — I reformatted it
     (same file I'm committing, trivial correct fix, no logic change).
   `bun run check` was therefore already failing before Task 3; after this
   commit it fails only on the Task 1 file.
