---
ticket: 04-split-diagram-fit
effort: archify-deck-visual-fidelity
type: task
status: open
created: 2026-08-21
last: 2026-08-21
---
# 04 — measure the split slide's diagram placement before changing it

> Spec §2.4, §4 (P4), decision D5.

## The observation

On composed slide 3 the diagram occupies roughly the lower half of its column with a large
empty band above it. `addShapeIrToSlide` is documented to scale uniformly and centre inside
the target `Box`, so the render disagrees with the documentation.

**Attribution is not established, and this ticket does not assume a bug.** Two candidates:

1. centring is wrong — the diagram is placed against the box's bottom-left rather than its
   centre;
2. centring is right, and the artifact's own bounding box includes the legend row plus empty
   canvas, so the *visible* content sits low inside a correctly-centred but mostly-empty
   box.

Candidate 2 is at least as likely as candidate 1 — the legend row in the round-1 render sits
well below the diagram frame.

## What to build

**First a measurement, then a change only if the measurement calls for one.**

Compare, for composed slide 3: the artifact SVG's own `viewBox` / content bbox, the target
`Box` handed to `addShapeIrToSlide`, and the emitted `<a:off>` / `<a:ext>` of the resulting
shapes. Record the three side by side in the ticket Result.

- If candidate 1: fix the centring, assert the emitted bbox is centred in its box.
- If candidate 2: the honest fix is fitting to the diagram's **content** bbox rather than its
  canvas bbox. That is a bigger change than it looks — it affects the `diagram` layout too,
  where today's geometry is locked to the coordinate by D3 of the prior effort. If so,
  **stop and re-scope** rather than quietly changing the locked path.
- If neither — placement is correct and the emptiness is in the source diagram: close the
  ticket with the measurement, change nothing.

## Acceptance

- The three-way measurement is recorded whatever the outcome.
- Any change ships with an assertion pinning the placement, computed from emitted OOXML.
- The `diagram` layout's locked geometry is either untouched or the lock is explicitly and
  separately renegotiated.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
