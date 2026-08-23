# Task 1 report: ask_user_question CC-parity schema + validation

**Commit:** `d7a5501a` — `feat(task): ask_user_question CC-parity schema — header 12, suffix recommended, preview single-select` (branch `cc-parity-task-ext`)

## What was implemented

- `tool/types.ts`
  - `MAX_HEADER_LENGTH` 16 → 12; header description rewritten to CC wording (`Max ${MAX_HEADER_LENGTH} characters.` + examples).
  - `MAX_LABEL_LENGTH` deleted; `OptionSchema.label` `maxLength` + hard-limit sentence removed, description = CC wording.
  - Added `RECOMMENDED_SUFFIX = " (Recommended)"` and `hasRecommendedSuffix(label)` in the constants block (placed with the other MAX_* constants; brief said "after MAX_OPTIONS" — same block).
  - Deleted the `recommended` field from `OptionSchema`; `preview` description = CC wording (side-by-side markdown box, single-select only); `multiSelect` description = CC wording.
  - `QuestionnaireError` union: added `"preview_on_multiselect"` **and** `"header_too_long"` (see Deviation 1).
- `tool/validate-questionnaire.ts`
  - Import: dropped `MAX_LABEL_LENGTH`, added `hasRecommendedSuffix`, `MAX_HEADER_LENGTH`.
  - `recommendedCount` now counts `hasRecommendedSuffix(o.label)`; message updated to `options labeled "(Recommended)"`.
  - Deleted the `opt.label.length > MAX_LABEL_LENGTH` rejection block.
  - Added `preview_on_multiselect` rejection when `q.multiSelect === true` and any option has a non-empty string `preview`.
  - Added `header_too_long` rejection when `q.header.length > MAX_HEADER_LENGTH` (see Deviation 1).
- New test `__tests__/cc-parity-schema.test.ts` (7 tests, per brief with one literal fix — Deviation 2).
- Migrated `tool/__tests__/types.test.ts`: removed `MAX_LABEL_LENGTH` import + its reject test + constants assertion; `MAX_HEADER_LENGTH` expectation 16 → 12. No other test files needed migration (grep: all authored headers ≤ 12 chars — "Architecture" is exactly 12 and still passes; no `recommended:` authored outside `recommended-marker.test.ts`).

## Deviations from the brief (both required to satisfy the brief's own tests)

1. **Header-length check added to `validateQuestionnaire` + `header_too_long` error kind.** The brief's Step 3 edit list for `validate-questionnaire.ts` contains no header check, but its Step 1 test `header over 12 chars is rejected` calls `validateQuestionnaire` directly and expects `ok: false` with a message containing "12". Previously NO runtime header check existed anywhere (only the typebox `maxLength` via `Value.Check` in the schema path). The test is the spec, so the check was added. This required one extra `QuestionnaireError` kind beyond the brief's "ADD `preview_on_multiselect` only" instruction — no exhaustive switches or external consumers of the union exist (verified by grep), so the addition is safe.
2. **Test literal fix.** The brief's `header of exactly 12 chars passes` uses `"12 characters"`, which is 13 characters, so the test can never pass with `MAX_HEADER_LENGTH = 12`. Replaced with `"Auth method!"` (exactly 12) and noted why in a comment.

## TDD evidence

- **RED:** `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/cc-parity-schema.test.ts )`
  → `SyntaxError: Export named 'RECOMMENDED_SUFFIX' not found in module '.../tool/types.ts'` — 0 pass / 1 fail. Expected: the new exports did not exist yet.
- **GREEN (after schema edits, before literal fix):** 6 pass / 1 fail — the remaining failure exposed Deviation 2 (13-char literal).
- **GREEN (final):** same command → `7 pass / 0 fail / 13 expect() calls`.

## Testing

- Focused: `bun test src/ask-user` → 274 pass / 1 fail; the single failure is `recommended marker > validation rejects more than one recommended option per question` — **EXPECTED and left as-is**: the brief says `recommended-marker.test.ts` belongs to Task 3 (it tests the view layer this task intentionally orphans).
- Full package suite once before commit: `( cd bun-apps/s2-agent-ext-task && bun test )` → **879 pass / 1 fail (the same expected recommended-marker test) / 5240 expect() calls / 880 tests across 64 files**.
- `bun run typecheck` (tsc --noEmit): 2 errors, both deferred by design to Tasks 2–3:
  - `src/ask-user/ask-user-question.ts(66,18)`: `recommended: o.recommended` reads the deleted field.
  - `src/ask-user/view/components/multi-select-view.ts(81,21)`: `opt?.recommended` reads the deleted field.
  These are the tool-description and view-layer files Tasks 2–3 rewrite; `wrapping-select.ts` uses its own local item type and is unaffected.

## Files changed

- `bun-apps/s2-agent-ext-task/src/ask-user/tool/types.ts`
- `bun-apps/s2-agent-ext-task/src/ask-user/tool/validate-questionnaire.ts`
- `bun-apps/s2-agent-ext-task/src/ask-user/tool/__tests__/types.test.ts`
- `bun-apps/s2-agent-ext-task/src/ask-user/__tests__/cc-parity-schema.test.ts` (new)

## Self-review findings

- Completeness: all brief steps done; edge cases covered by tests (exact-boundary header, long label accepted, suffix exact-match via `hasRecommendedSuffix` including trailing-space and lowercase variants).
- Quality: followed existing typebox/validation file idioms; no restructuring outside scope.
- Discipline: deleted the label-limit test rather than duplicating an "accepted" variant already covered by `cc-parity-schema.test.ts`.
- Testing: pristine output verified; no hand-assembled gate subsets — package's canonical `bun test` run.

## Concerns

1. Deviations 1–2 above — the lead should confirm the `header_too_long` union addition is acceptable (it is required by the brief's own test).
2. `tsc --noEmit` is red in exactly 2 view/tool sites until Tasks 2–3 land — expected mid-effort state on this stacked branch, but the branch must NOT merge before Task 3 fixes them.
3. `recommended-marker.test.ts` still failing (1 test) — deliberate, per brief.
