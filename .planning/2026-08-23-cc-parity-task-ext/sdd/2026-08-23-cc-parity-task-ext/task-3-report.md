# Task 3 report — view layer: suffix-driven ⭐ + monospace preview box (+ ticket 01 close-out)

## Implemented

- `src/ask-user/ask-user-question.ts` — `buildItemsForQuestion` now derives `recommended` via `hasRecommendedSuffix(o.label)` (import added to the existing `./tool/types.js` block). Deviation from the brief's snippet: `recommended: hasRecommendedSuffix(o.label) ? true : undefined` instead of the bare boolean call — the brief's snippet and its own rewritten test were mutually inconsistent (bare call sets `false` on unsuffixed options; the test asserts `toBeUndefined()`). Test kept verbatim as the authoritative TDD artifact.
- `src/ask-user/view/components/wrapping-select.ts` — `renderItem`: `isRec` = option + `recommended === true`; star `⭐ ` when rec; `displayLabel` strips `RECOMMENDED_SUFFIX` (display only); both the plain and the confirmed (`confirmedLabelOverride ?? displayLabel`) paths render `displayLabel`, so every visible row is suffix-free. Wrapping math already runs downstream on the composed display string. This was the only `item.label` use in the render path — the swap was clean, not awkward.
- `src/ask-user/view/components/multi-select-view.ts` — transitional red cleared (was not in the brief's file list but the team-lead context named it as a MUST-clear): `renderRow` derives ⭐ from `hasRecommendedSuffix` and strips the suffix from the displayed label.
- `src/ask-user/view/components/preview/preview-block-renderer.ts` — preview body now monospace-verbatim: hard-clip each authored line at `width`, no re-wrap; `wrapTextWithAnsi` import removed (no other use in the file).
- `src/ask-user/__tests__/recommended-marker.test.ts` — rewritten verbatim to the brief's CC-suffix form (4 tests).
- Ticket close-out: `.planning/2026-08-23-cc-parity-task-ext/tickets/01-ask-user-cc-parity.md` → `status: closed` + `## Result` (notes full markdown rendering of previews deliberately not built).

## Tested + results

- RED (Step 2): rewritten test failed exactly as predicted — `recommended` undefined from `buildItemsForQuestion`, no ⭐ in render, raw label shown.
- GREEN (Step 4): `recommended-marker.test.ts` 4/4 pass.
- Ticket 01 gate: `( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )` — typecheck clean, **880 pass / 0 fail across 64 files**. Ask-user subtree: 275 pass / 18 files. Both transitional reds (`ask-user-question.ts:66`, `multi-select-view.ts:81`) cleared.
- Preview-text migration: none needed — cards-ux2-roundtrip and other preview tests already assert authored lines; the old soft-wrap only differed for lines wider than the box, which no test exercised.

## TDD evidence

Step 2 run output: `2 pass / 2 fail` — `buildItemsForQuestion derives recommended from the suffix` failed on `expected true, received undefined`; `WrappingSelect renders ⭐` failed on missing `⭐` with received render `"❯ 1. Alpha (Recommended)\n …"` (raw label, no star). Implementation followed; same command then 4/4.

## Files changed (commit 7be565dd)

- `bun-apps/s2-agent-ext-task/src/ask-user/ask-user-question.ts`
- `bun-apps/s2-agent-ext-task/src/ask-user/view/components/wrapping-select.ts`
- `bun-apps/s2-agent-ext-task/src/ask-user/view/components/multi-select-view.ts`
- `bun-apps/s2-agent-ext-task/src/ask-user/view/components/preview/preview-block-renderer.ts`
- `bun-apps/s2-agent-ext-task/src/ask-user/__tests__/recommended-marker.test.ts`
- `.planning/2026-08-23-cc-parity-task-ext/tickets/01-ask-user-cc-parity.md` (close-out commit)

## Self-review

- Completeness: all brief steps done; both transitional reds cleared; full package gate green (ticket 01's gate now passes end-to-end across Tasks 1–3).
- Quality: display-strip logic lives at the two render sites that show option labels; answer path untouched (stored label keeps suffix — asserted by test).
- Discipline: bun run from subshell; English comments; two commits (feat + docs close-out); no files outside the brief's scope + the named transitional red.

## Concerns

- `PreviewBlockRenderer`'s header line `Preview: ${option.label}` still shows the authored label with the "(Recommended)" suffix when the previewed option is the recommended one. The brief scoped changes to the body loop only, so I left it; flagging as a possible cosmetic follow-up.
- Brief snippet/test inconsistency (documented above) — resolved in favor of the test.
- `.planning/2026-08-23-cc-parity-task-ext/sdd/` is still untracked (holds task briefs/reports from all three tasks); left for the team-lead to commit in one piece to avoid racing the review agents' in-flight report writes.
