---
ticket: 02-title-overflow-exemption
effort: archify-foldback-audit
type: task
status: done
created: 2026-08-23
last: 2026-08-23
blocked-by: []
---
# 02 — Chrome-suppressed `title-overflows` exemption

> Spec **D2/D3**. The fold-back item (c): `quote` (`chrome: {title:false}`) and `end` (`chrome: false`)
> never draw the title band, so `title-overflows` is a false `error` on an authored long `title`.

## Problem (measured 2026-08-23)

`lintDeck` (`src/deck-lint.ts:156-179`) exempts only `layout === "statement"` (:176) from the
overflow check. The two shipped divider-class templates suppress the band inside `loadTemplate`
(`src/layout-template.ts:600-631`, `chromeSpec !== true` ⇒ no full-title chrome). `lintDeck` has no
template metadata, so it cannot know a template suppresses the title.

## Change

1. `src/layout-template.ts` — add `titleSuppressed: boolean` to `LoadedTemplate` (`:60-63`), computed
   in `loadTemplate` from `chromeSpec`: `chromeSpec === false || (isObject(chromeSpec) && chromeSpec.title === false)`.
   Return it in the object literal at `:639`.
2. `src/layout-registry.ts` — add `titleSuppressedLayouts(): string[]` to `LayoutRegistry` (`:42-49`)
   and implement it: `["statement", ...templates].filter and map to names where the template's
   `titleSuppressed` is true`. (The code layout `statement` always suppresses the band.)
3. `src/deck-lint.ts` — extend `LintableDeck` with optional
   `suppressedTitle?: ReadonlySet<string>` (`:47-49`); in `lintDeck`, compute a
   `titleSuppressed(layout)` that is true for `layout === "statement"` OR
   `deck.suppressedTitle?.has(layout)`. Use it in place of the `layout !== "statement"` guard at `:176`.
   `cardinality`: the union always includes `statement`.
4. Thread the set through the three callers that already have a registry:
   - `src/deck-build.ts:412` — `lintDeck({ slides, suppressedTitle: new Set(registry.titleSuppressedLayouts()) })`.
   - `src/deck-lint-tool.ts:201` — `lintDeck(manifest, { suppressedTitle: new Set(reg.titleSuppressedLayouts()) })`;
     `reg` is already built at `:180-184`. Update the signature if `lintDeck` takes a second arg.
   - `src/export-pptx.ts:166` — build a registry from `manifestDir`/`ctx.env` (it already has both)
     and pass the set; or reuse where cheap.
5. Tests (`tests/deck-lint.test.ts`):
   - a `quote` slide with a long `title` (that would overflow on a `bullets` slide) yields **no**
     `title-overflows` note (when `suppressedTitle` includes `quote`); a `bullets` slide with the same
     `title` still does.
   - `end` behaves the same.
   - a `statement` slide stays exempt without any `suppressedTitle` (regression guard).

## Done when

- [ ] `LoadedTemplate.titleSuppressed` exposed; `LayoutRegistry.titleSuppressedLayouts()` returns
      `statement` + the `quote`/`end` templates.
- [ ] `lintDeck` skips `title-overflows` for `statement`, `quote`, `end` (via `suppressedTitle`).
- [ ] All three internal callers pass the set; no `lintDeck({ slides })` caller breaks (opt-in).
- [ ] New tests pin the exemption and the non-exemption; `bun test` + `bun run typecheck` green.
