---
ticket: 02-svg-theme
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
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
