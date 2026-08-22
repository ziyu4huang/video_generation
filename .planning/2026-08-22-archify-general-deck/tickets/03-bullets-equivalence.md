---
ticket: 03-bullets-equivalence
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocked-by: [01]
---
# 03 — prove the vocabulary is sufficient, not merely convenient

> Spec §5. **This is the effort's frontier — write it while 01 is being built, not after.**

## Why this exists

Seven templates chosen by the same person who designed the vocabulary will always fit that
vocabulary. That proves nothing. The only honest check is to take a layout that was designed
**before** the vocabulary existed and rebuild it in the vocabulary alone.

`bullets` is the right subject: it uses `chrome`, a takeaway-conditional origin, a capped
width (10.5 in, not the full 12.333), and a `bullets` content block. If the primitives cannot
reach it, they cannot reach a real layout.

## What to build

`__tests__/fixtures/bullets-equiv.layout.json` — a template reconstruction of `bulletsLayout`
— and `__tests__/bullets-equivalence.test.ts` asserting:

```
formatBlocks(templateRender(slide, ctx)) === formatBlocks(bulletsLayout(slide, ctx))
```

**line for line**, for at least: with a takeaway, without one, with `source`, with `subtitle`
only, with zero bullets, and with level-1 nesting.

The fixture is a **test fixture, not a shipped template** — it must not be on any search path
and must not appear in the catalog.

## If it fails

A gap here is a vocabulary bug, not a fixture bug. Do **not** widen the template to match by
adding a special case; extend a primitive, re-run, and record what was missing in `map.md`
§ Fog of war. Resist adding a fifth primitive for a single caller — check first whether the
gap is really `region`'s takeaway-awareness or `box`'s inset semantics.

## Acceptance

- Identical output for all six input shapes above.
- The fixture is absent from `catalog()`.
- A deliberate mutation of the fixture (shift one inset by 0.1) makes the test fail — a test
  that cannot fail is the failure mode this repo has already been burned by.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
