---
ticket: 04-emit-html
effort: archify-slide-composition
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocks-on: [01, 02]
blocking: [05]
---
# 04 — `lib/emit-html.ts`

> Spec §4.5, decision D4.

## What to build

`emitHtmlSlide(blocks, ctx) => string` — self-contained: one inline `<style>`, no external
asset, `.stage` at `aspect-ratio: 16/9` with `position: relative`, each block absolutely
positioned at its box in `%`. `diagram` → `<iframe>` at the sibling archify artifact.

**D4 is load-bearing**: a `diagram` slide does NOT go through this module. Its
`slide-N.html` remains the archify artifact itself, so the webui Diagram pane's
"full-fidelity and interactive" property is untouched.

## Acceptance

- Output parses as HTML and contains no `http://` / `https://` reference.
- Every block's text appears in the output.
- A `diagram` slide never reaches this emitter (asserted at the orchestrator level).

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Result

**closed 2026-08-21** — `lib/emit-html.ts` + `__tests__/emit-html.test.ts` (15 tests),
including a cross-emitter consistency test: for every composed layout, the set of strings
reaching the PPTX must appear in the HTML.

- Sizes are shared with the PPTX side through `--pt: calc(100cqw / 960)` (13.333 in = 960 pt),
  so `deck-theme.ts`'s point values are used unchanged by both and cannot drift.
- **`?embed=1&theme=…` was the finding here.** Verified in `Bun.WebView`: a `file://` iframe
  of a sibling file renders, but WITHOUT the param a `split` slide showed the archify
  artifact's entire page UI — its own dark toolbar and its own title — inside a 60 % column,
  repeating the title above it. The param is the artifact's own contract, read out of
  `vendored/assets/template.html`; not a hack played on it.
- The frame is sized to the diagram's own aspect (from `ShapeIR.width/height`) and centred,
  and carries no border — a plate around a diagram that does not fill it reads as a mismatch.
