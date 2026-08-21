---
ticket: 03-node-text-advance
effort: archify-deck-visual-fidelity
type: task
status: open
created: 2026-08-21
last: 2026-08-21
---
# 03 — CJK text in diagram nodes is clipped by a Latin advance guess

> Spec §2.3, §4 (P3).

## The defect

In the rendered `.pptx`, `SYS.1/2 需求來源` inside the MRD node is clipped, and the connector
label `系統需求` breaks as `系統需 / 求`. Source: `lib/pptx-shapes.ts` places SVG text with
`wrap: false` and width `node.fontSize * 0.62 * text.length * 1.35` — a Latin advance
applied to full-width glyphs whose true advance is ≈ 1.0 em.

`0.62 * 1.35 ≈ 0.837 em` per character. For CJK that under-reserves by ~16 %, which is
exactly enough to clip a label that fits in the HTML twin.

## What to build

Make the estimate script-aware: classify each character as full-width (CJK ideographs, kana,
full-width forms, CJK punctuation) or not, and sum ≈ 1.0 em against ≈ 0.837 em rather than
multiplying one factor by `.length`.

Keep `wrap: false`. This path reproduces a **fixed diagram layout** where the SVG already
decided where the line breaks are — turning on wrapping would reflow text the diagram
positioned deliberately. The prior effort's §2.3 reasoning holds; only the advance is wrong.

## Acceptance

- A width contract asserted on the emitted text box: for a set of fixture strings spanning
  pure-Latin, pure-CJK and mixed, the reserved width is ≥ the script-aware estimate.
- Text that fits in the HTML twin is not clipped in the `.pptx`, checked once by eye via
  ticket 05.
- No renderer in the assertion.
- Diagram slides in the legacy deck still build; expect and account for width bytes moving.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
