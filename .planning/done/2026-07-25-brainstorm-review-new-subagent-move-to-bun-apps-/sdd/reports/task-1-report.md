# Task 1 Report — `collectSubagentOutputs()` pure collector + unit tests + shared-path guard

**Status:** ✅ Complete — implemented verbatim per the plan, TDD order followed.

## Commit

- **SHA:** `cd6d9538`
- **Subject:** `feat(hermes-memory): collectSubagentOutputs — dedicated capture for learning loop`
- **Files (exactly 2):**
  - `bun-apps/pi-agent-ext-hermes-memory/src/handlers/message-parts.ts` (modified — appended constants + `readToolResultContent` + `collectSubagentOutputs`; existing `collectMessageParts` / `applyRecentMessageLimit` / `getMessageText` import untouched)
  - `bun-apps/pi-agent-ext-hermes-memory/tests/handlers/message-parts.test.ts` (created)

## TDD trace

| Step | Action | Result |
|------|--------|--------|
| 1 | Created test file verbatim | ✅ |
| 2 | Ran test pre-impl | ❌ FAIL — `Export named 'collectSubagentOutputs' not found` (expected) |
| 3 | Appended impl verbatim | ✅ |
| 4 | Ran target test file | ✅ PASS — **10/10** |
| 5 | Ran full hermes suite | ✅ PASS — **705/705** |
| 6 | Committed (2 files, exact message) | ✅ `cd6d9538` |

## Test summary

- **Target file** (`tests/handlers/message-parts.test.ts`): **10 pass / 0 fail**
  - 9 `collectSubagentOutputs` assertions (id-match, non-subagent skip, Anthropic `tool_use` variant, string vs text-block content, 500-vs-4000 cap semantics, 4000 hard cap, empty branch, orphan `tool_result`, multiple-in-order)
  - 1 regression guard — `collectMessageParts` (shared path) still excludes `tool_result` blocks
- **Full suite** (`bun test`): **705 pass / 0 fail** across 53 files (baseline was 695; +10 from this new file — no collateral damage). `session-flush` and `correction-detector` suites green.

## Constraints honored

- ✅ No top-level `cd` — all commands via subshells `( cd ... && ... )`.
- ✅ Test style = `node:test` + `node:assert` (NOT `bun:test`'s `expect`).
- ✅ `src/types.ts` NOT touched — `git diff` empty (verified). `getMessageText` stays text-only by design.
- ✅ `collectMessageParts` / `applyRecentMessageLimit` / the `getMessageText` import byte-unchanged.
- ✅ Commit scope: ONLY the 2 intended files staged (no `git add -A`); `git status --short` clean post-commit.

## Deviations / concerns

None. Implementation, tests, and commit message match the plan verbatim. Ready for Task 2 (wiring into `background-review.ts` + integration test + CONTEXT.md).
