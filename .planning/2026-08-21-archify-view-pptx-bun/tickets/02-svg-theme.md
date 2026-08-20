---
ticket: 02-svg-theme
effort: archify-view-pptx-bun
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocking: [03]
---
# 02 — archify: `lib/svg-theme.ts` (class → style token table + drift guard)

> Spec §4.1 / §5.2. Decision D3.

## Goal

Resolve archify's CSS-class styling into explicit style tokens without implementing a CSS
engine — and make a vendored bump that adds a class fail loudly.

## What to build

1. `lib/svg-theme.ts`: `resolveStyle(classList: string[], theme: "light"|"dark"): Style`
   where `Style = {fill?, stroke?, strokeWidth?, dash?, color?, fontWeight?, opacity?}`.
   Cover the measured vocabulary — `c-*` (component/frame), `t-*` (text), `m-*` (marker),
   `a-*` (arrow), `s-*`, `sigil-*`. 31 classes are defined in
   `vendored/assets/template.html`; 28 appear in the sample artifact. Derive the values from
   the template's CSS ONCE, by hand, and record the derivation date in a file comment.
2. Inline presentation attributes on the node WIN over the class table (archify sets
   `stroke-width`, `font-size`, `font-weight`, `text-anchor` inline).
3. `__tests__/theme-drift.test.ts`: scan the template plus every rendered vendored example;
   every class token on a painted element must exist in the table. Unknown class ⇒ fail with
   the class name and the file it came from.

## Acceptance

- All 28 classes used by the sample artifact resolve to a non-empty style in both themes.
- Adding a fake class to a fixture makes the drift test fail with a useful message.

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`

## Result

**closed 2026-08-21** — `lib/svg-theme.ts` + `__tests__/theme-drift.test.ts` (22 tests). The
guard renders ALL 13 vendored examples (558 ms total, measured) so all five diagram types are
covered, not just architecture — no skip gate.

**Correction found during build**: `semantic-sigil` was initially recorded as structural. It
is not — `svg .semantic-sigil` sets `fill:none; stroke:currentColor; stroke-width:1.35;
opacity:0.76`, and the sigil glyphs are UNCLASSED children that get their paint purely by SVG
inheritance. Treating it as decoration rendered every glyph invisible. Fixed by adding real
inherited-property support (`inheritStyle`) plus `vector-effect: non-scaling-stroke` handling;
`resolveStyle` also gained a first pass for `color` so `currentColor` sees an own-element
`s-*` class regardless of class order. Caught by ticket 03's "every node carries resolved
paint" assertion.
