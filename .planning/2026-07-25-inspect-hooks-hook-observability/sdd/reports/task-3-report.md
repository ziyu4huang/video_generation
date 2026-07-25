# Task 3 Report — Wire `inspect_hooks` `execute()` (live + self_test + JSON)

## What was implemented

Filled in the real body of `makeInspectHooksTool` in
`bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts`, replacing the
Task-1 placeholder (which always returned a degenerate `available:false`
snapshot). The new `execute()` implements three branches:

1. **`self_test: true`** — ignores the live `ctx` entirely and runs against a
   deterministic in-memory `HooksSnapshot` mock (one extension with a real
   `turn_end` handler and an unknown `turn_starts` handler), returning the
   rendered text report prefixed with `"self_test: true\n\n"`. No live session
   is required, so the test passes `{} as never` for `ctx`.
2. **`return_json: true`** — calls `(ctx as ExtensionContext).getHooks()`
   (the polyfill installed by Task 2), runs `analyzeHooks`, and returns a
   machine-readable JSON string of `{ findings, summary: summarizeFindings(findings), snapshot }`.
3. **default (text)** — returns `formatHooksReport(snapshot, findings, by_event)`.

Also appended the 4 tool end-to-end tests (the `import { makeInspectHooksTool }`
line + the `describe("inspect_hooks (tool end-to-end, fake ctx)")` block) to
the existing `src/tools/__tests__/inspect-hooks.test.ts`.

### Resolution of the cross-task discrepancy (per task brief)

The brief's Step 3 said to DELETE a trailing `export { };` + `export type { ExtensionContext }`
block left by Task 1. **That block does not exist** — Task 1 already omitted it.
Confirmed by `grep` for `export {` / `export type` in the file: no matches.
Accordingly, nothing was deleted. The only change to `inspect-hooks.ts` was
replacing the `makeInspectHooksTool` function body. The top import was already
`import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";`
(left unchanged, as instructed).

## TDD evidence

### RED — before implementing (placeholder execute)

Appended the 4 new tests, then ran:

```
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```

Result: **3 fail / 1 pass / 11 pass** (14 total). The placeholder `execute`
hard-codes `snapshot = { extensions: [], available: false }` and ignores all
params, so:

- `text report surfaces unknown-event finding` → FAIL. The placeholder ignores
  the fake ctx's snapshot and returns the `available:false` report
  (`"Hooks unavailable …"`), which does not contain `'unknown event "turn_starts"'`.
- `return_json=true returns {findings, summary, snapshot}` → FAIL. The
  placeholder ignores `return_json` and returns the text report (begins with
  `╔`), so `JSON.parse` throws `SyntaxError: Unrecognized token '╔'`.
- `self_test=true returns deterministic mock` → FAIL. The placeholder ignores
  `self_test`, so the output never contains `"self_test"`.
- `hooks-unavailable degrades gracefully` → PASS *by coincidence*: the
  placeholder happens to always emit the unavailable report this test expects.

### GREEN — after implementing the real execute

Same command after replacing the body:

```
14 pass
0 fail
31 expect() calls
Ran 14 tests across 1 file. [235.00ms]
```

All 4 new tool end-to-end tests pass, plus the 10 pre-existing pure-logic tests
from Tasks 1.

## Full-suite result

```
( cd bun-apps/pi-agent-ext-power-tool && bun test )
```

```
136 pass
4 skip
0 fail
374 expect() calls
Ran 140 tests across 13 files.
```

The 4 skipped are the package's L2 end-to-end tests gated behind `PI_RUN_L2=1`
(`inspect_context`, `inspect_agent`, `inspect_extensions`, `inspect_pathology`)
— the package's standard convention, unrelated to this change. Output is
pristine (no errors, no warnings, no console noise).

`bunx tsc --noEmit` ran clean (no output), confirming the
`(ctx as ExtensionContext).getHooks()` cast resolves against Task 2's
`ExtensionContext` augmentation.

## Files changed

- `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts` — replaced the
  `makeInspectHooksTool` function body (placeholder → real execute with
  self_test / return_json / text branches).
- `bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts`
  — appended the `import { makeInspectHooksTool }` line and the 4-test
  `describe("inspect_hooks (tool end-to-end, fake ctx)")` block.

Commit: `9f69afaa` —
`feat(power-tool): wire inspect_hooks execute (live snapshot + self_test + JSON)`.

## Self-review findings

- ✅ `makeInspectHooksTool` body matches the brief verbatim (parameters,
  description, all three branches, return shapes).
- ✅ Top import is exactly
  `import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";`
  — unchanged.
- ✅ The "DELETE trailing `export { };`" instruction was a no-op (block never
  existed); verified, nothing removed.
- ✅ `summarizeFindings` is consumed by the `return_json` branch exactly as the
  brief's Interfaces list specifies.
- ⚠️ **Minor cosmetic (not a defect, left untouched per brief):** the header
  comment block immediately above `makeInspectHooksTool` (lines 231–233) still
  reads `"Declared here so Task 1 compiles; execute() is filled in Task 3."` /
  `"(Placeholder return kept minimal — Task 3 replaces it.)"`. These are now
  mildly stale, but the brief only specifies replacing the function body and
  confirms the import; editing surrounding comments would be scope creep beyond
  the verbatim instruction, so they were left as-is. No functional impact.

## Concerns

None blocking. The stale header comment noted above is cosmetic only and was
intentionally left in place to stay within the brief's verbatim scope.

---

## Post-Task 3 fix: Removed stale placeholder comment (2026-07-25)

### What was fixed

Removed the 3-line stale comment block above `makeInspectHooksTool` that
contradicted the now-real implementation (claimed it was a Task 3 placeholder,
but the function body below it is the actual ~40-line implementation).

### Exact change

**Removed (3 lines):**
```ts
// ─── Tool factory (body added in Task 3) ────────────────────────────────────
// Declared here so Task 1 compiles; execute() is filled in Task 3.
// (Placeholder return kept minimal — Task 3 replaces it.)
```

**Added (1 line):**
```ts
// ─── Tool factory ────────────────────────────────────────────────────────────
```

### Verification

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```

**Result:**
```
14 pass
0 fail
31 expect() calls
Ran 14 tests across 1 file. [241.00ms]
```

All tests pass (comment-only change, no behavior change).

### Commit

- **SHA:** `2a66a145`
- **Subject:** `style(power-tool): remove stale placeholder comment over makeInspectHooksTool`
- **File:** `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts`
