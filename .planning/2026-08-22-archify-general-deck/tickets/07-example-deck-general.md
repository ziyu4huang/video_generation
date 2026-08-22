---
ticket: 07-example-deck-general
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocked-by: [06]
---
# 07 — `examples/deck-general/`, and the out-of-repo proof

> Spec §6 gates 4 and 5.

## What to build

`examples/deck-general/` — a manifest exercising **all seven** new templates alongside a
couple of code layouts, in the style of `examples/deck-composed/` (which is the canonical
six-layout showcase). `.gitignore` it the same way: `*.pptx`, `*.slides/`. Manifest in, build
products out.

Extend `__tests__/deck-composition.test.ts` to build it and assert per slide: `<a:blip>` = 0,
`lintPptx` clean.

## The gate that actually proves the claim

Gates 1–4 all run inside the repo, where the shipped templates are on the shipped search
path. They cannot distinguish "templates work" from "these seven files work".

So: a test that writes a template to a **temp directory outside the repo**, points
`$ARCHIFY_TEMPLATES` at it, and asserts the layout appears in `catalog()` and renders in a
built deck. "Add a file on the search path and you have a new layout" is the entire claim of
this effort; an in-repo fixture cannot prove it.

## Acceptance

- `bun run deck examples/deck-general/deck.config.json --lint` → content lint clean, ooxml
  lint clean, blip 0 per slide.
- The out-of-repo template test passes and cleans up its temp dir in a `finally`.
- `bun run deck examples/deck/deck.config.json` still reports **5 slides, 388 native shapes**
  — the legacy deck is the compatibility canary and its numbers are the ones to watch.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
