# Task 2 Report — Wire subagent outputs into the background-review loop

**Plan:** `02-subagent-output-distill.md` → Task 2
**Status:** ✅ Complete

## Commit

- **SHA:** `46f28919e6e71b22795e7b30f85a58d203dabe4c`
- **Subject:** `feat(hermes-memory): feed subagent outputs into the background-review learning loop`
- **Scope (exactly 3 files):**
  - `bun-apps/pi-agent-ext-hermes-memory/src/handlers/background-review.ts` (import + `turn_end` parts assembly)
  - `bun-apps/pi-agent-ext-hermes-memory/tests/handlers/background-review.test.ts` (1 integration test)
  - `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md` (learning-loop note)

## TDD trace (Step 1 → 7)

1. **Step 1** — Added integration test `includes captured subagent outputs in the review prompt` inside `describe("setupBackgroundReview", …)` right after the existing `uses the full conversation by default` test. Reused `createMockPi` / `setupWithSpawn` / `fireMessageEnd` / `fireTurnEnd` / `makeBranch` / `reviewTask` / `settle` exactly as the mirror test does.
2. **Step 2** — Ran `bun test tests/handlers/background-review.test.ts` → **FAIL** as predicted (`task.includes("The subagent surfaced a reusable pattern")` false; 26 pass / 1 fail).
3. **Step 3** — Applied the verbatim `background-review.ts` change: added `collectSubagentOutputs` to the import, replaced the `allParts`/`parts` block with `convoParts` + `subagentParts`, kept the `< 4` gate on `convoParts`, assembled `parts = [...applyRecentMessageLimit(convoParts, …), ...subagentParts]`.
4. **Step 4** — Re-ran the integration test → **PASS** (27 pass / 0 fail).
5. **Step 5** — Full suite: `706 pass / 0 fail` (baseline 705 + 1 new integration test). `git diff origin/main -- …/src/types.ts` → **EMPTY** (shared `getMessageText` untouched).
6. **Step 6** — Appended the verbatim `## Learning loop: subagent-output capture` note to `CONTEXT.md`.
7. **Step 7** — Committed exactly the 3 files with the exact message. No `git add -A`; `src/types.ts` and `src/handlers/message-parts.ts` (Task 1) were NOT touched.

## Test summary

| Run | Result |
| --- | --- |
| `bun test tests/handlers/background-review.test.ts` (Step 2, pre-wire) | 26 pass / **1 fail** |
| `bun test tests/handlers/background-review.test.ts` (Step 4, post-wire) | **27 pass** / 0 fail |
| `bun test` full suite (Step 5) | **706 pass** / 0 fail |

## Shared-path / regression confirmation

- `git diff origin/main -- bun-apps/pi-agent-ext-hermes-memory/src/types.ts` → **EMPTY** ✅
- `getMessageText` / `collectMessageParts` byte-unchanged → `session-flush` and `correction-detector` paths unaffected (full suite green confirms).
- `collectSubagentOutputs` from Task 1 (commit `cd6d9538`) was imported unchanged.

## Deviations / concerns

None. Implementation followed the plan verbatim (Step 1 test, Step 3 source change, Step 6 CONTEXT note, Step 7 commit message). The `< 4` conversation-parts gate now lives inside the `try` block (per the verbatim Step 3 code) — behavior preserved: short conversations still short-circuit before the `reviewInProgress=false` release. The `catch` path (e.g. `getBranch` throws) remains covered by the existing `falls back gracefully if getBranch throws` test, still passing.

## Report path

`/Users/huangziyu/proj/video_generation__memory/.planning/2026-07-25-brainstorm-review-new-subagent-move-to-bun-apps-/sdd/reports/task-2-report.md`
