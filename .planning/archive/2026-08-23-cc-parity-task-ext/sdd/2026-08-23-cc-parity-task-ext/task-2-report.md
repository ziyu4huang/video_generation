# Task 2 Report: ask_user_question tool description CC rewrite

## Status: DONE

## Implemented

- Rewrote `registerAskUserQuestionTool` `description` in `bun-apps/s2-agent-ext-task/src/ask-user/ask-user-question.ts` to the CC structure from the brief: 1-4 questions intro, suffix-based "(Recommended)" convention (replacing the deleted `recommended: true` teaching), multiSelect-only-when-multiple-valid, preview as a usage-notes bullet (single-select only, monospace side-by-side), and the plan-mode rule (clarify before presenting a plan; never ask "is the plan ready").
- Replaced `DEFAULT_PROMPT_SNIPPET` (now "1-4 structured questions … or a decision is needed") and expanded `DEFAULT_PROMPT_GUIDELINES` from 2 to 4 entries per the brief (recommended-suffix rule, multiSelect/preview rule, batch + plan rule).
- Appended the `describe("CC-parity tool description")` block (plus its import) to `src/ask-user/__tests__/cc-parity-schema.test.ts` exactly as specified.

## Tested + Results

- `bun test src/ask-user` → **275 pass / 1 fail** (3696 expect() calls, 18 files). The single failure is `recommended-marker.test.ts` ("validation rejects more than one recommended option per question") — expected red until Task 3 migrates it, per brief.
- Standalone typecheck: not run as a gate; the two plan-named stale sites (view layer `recommended` read at ask-user-question.ts:66 inside `buildItemsForQuestion`) are owned by Task 3 and untouched.

## TDD Evidence

- **RED** (before rewrite): `expect(all).toContain("(Recommended)")` failed — received guidelines were the old 2-entry set with no "(Recommended)" and no plan rule. `7 pass / 1 fail` in cc-parity-schema.test.ts.
- **GREEN** (after rewrite): cc-parity-schema.test.ts `8 pass / 0 fail` (17 expect() calls).

## Files Changed

- `bun-apps/s2-agent-ext-task/src/ask-user/ask-user-question.ts` — description + DEFAULT_PROMPT_SNIPPET + DEFAULT_PROMPT_GUIDELINES
- `bun-apps/s2-agent-ext-task/src/ask-user/__tests__/cc-parity-schema.test.ts` — appended import + describe block

## Commit

- `868b05cd` feat(task): ask_user_question tool description rewritten to CC semantics

## Self-Review

- Completeness: all three brief targets (description, snippet, guidelines) replaced verbatim from the brief; test appended verbatim. Brief checkbox steps 1-5 all executed.
- Quality: description no longer teaches the deleted `recommended: true` field anywhere; guidelines mirror it consistently.
- Discipline: no files outside the brief touched; `buildItemsForQuestion`'s stale `recommended: o.recommended` read (view layer) deliberately left for Task 3; `recommended-marker.test.ts` untouched.
- Testing: RED verified before implementation, GREEN after, full ask-user suite run once.

## Concerns

- None blocking. Note (pre-existing, out of scope): `MAX_HEADER_LENGTH` is imported but unused in cc-parity-schema.test.ts — left as-is since editing it is outside this brief.
