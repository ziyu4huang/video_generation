---
ticket: 01-slide-model-and-theme
effort: archify-slide-composition
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocking: [02, 03, 04]
---
# 01 — `lib/slide-model.ts` + `lib/deck-theme.ts`

> Spec §4.1, §4.3. The vocabulary every later ticket speaks.

## Goal

One typed seam between authoring and rendering, and one home for "what colour / how big".

## What to build

`lib/slide-model.ts` — `FracBox`, `Role`, `BulletItem`, `BlockContent`, `PlacedBlock`,
`Slide`, `SlideLayout`, `LayoutCtx`, plus `formatBlocks(blocks): string` (one line per
block, `formatShapeIR` style — goldens must diff as "this box moved").

`lib/deck-theme.ts` — move `PALETTES` out of `deck-build.ts` **byte-identical** in its six
existing keys, extend with `body`, `muted`, `statement`, `panelBg`, `panelBorder`,
`sectionBg`, `sectionFg`. Add `TYPE_SCALE: Record<Role, {sizePt, bold?, tracking?}>`.
Add `STAGE = {w: 13.333, h: 7.5}` and `frac→inches` helpers.

`deck-build.ts` re-exports `PALETTES` — `__tests__` and any consumer must not break.

## Acceptance

- `resolveLayout(slide)` returns `"diagram"` for a slide with `ir` and no `layout`.
- Every `Role` has a `TYPE_SCALE` entry (exhaustive-record test).
- Existing `PALETTES.light/dark` values unchanged (pinned by a test).

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Result

**closed 2026-08-21** — `lib/slide-model.ts` + `lib/deck-theme.ts`, with
`__tests__/slide-model.test.ts` (18 tests).

- `PALETTES`' six original keys are pinned by a test and unchanged; seven new keys added for
  composed layouts. `TYPE_SCALE` is an exhaustive `Record<Role, TypeSpec>`, checked at runtime
  as well as by tsc — a Role added without a size would otherwise be a silently unstyled
  block rather than a compile error.
- `resolveLayout` also falls back by CONTENT (`statement` → `bullets` → `title`) when neither
  `layout` nor `ir` is present. `parseManifest` still rejects that case with a message naming
  both remedies, so the fallback only ever serves programmatic callers.
- `deck-build.ts` re-exports `PALETTES`; no consumer broke.
