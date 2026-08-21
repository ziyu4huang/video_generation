---
ticket: 07-deck-lint
effort: archify-slide-composition
type: task
status: open
created: 2026-08-21
last: 2026-08-21
blocks-on: [05]
blocking: [08]
---
# 07 — `lib/deck-lint.ts` — advisory storyline checks

> Spec §4.7, decision D7. Warns. **Never blocks a build.**

## What to build

`storyline(manifest) => string` — titles in order, numbered; the horizontal-logic read.

`lintDeck(manifest) => DeckLintNote[]` — title reads as a label not a claim; title > 90
chars; > 6 bullets on a slide; nesting deeper than level 1; any `#rrggbb` in authored text
(archify's Cardinal Rule extended to slide copy); missing `source` (info).

Surfaced by `bun run deck --lint` and in the `archify_export_pptx` result `details`.

## Acceptance

- A deliberately bad manifest produces one note per rule.
- A build with lint notes still exits 0 and still writes the `.pptx`.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
