---
ticket: 04-deck-lint-tool
effort: archify-general-deck
type: task
status: done
created: 2026-08-22
last: 2026-08-23
blocked-by: [02]
---
# 04 — `archify_deck_lint`: the catalog and the renderless check

> Spec §4.8. Decisions D8, D9.

## The problem being solved

`lintDeck()` runs only inside `archify_export_pptx` (`export-pptx.ts:126`), so the cheapest
way to learn that a title reads as a label is a full build — every IR through `deliver`,
every SVG through `parseSvg`, a `.pptx` on disk (0.26 s on `examples/deck/`). And there is no
way at all to ask which layouts exist.

## What to build

One registered tool (D8 — the fifth; the Markdown outline goes on `archify_export_pptx`,
not here):

```
archify_deck_lint { manifest?: string | object, baseDir?: string }
```

- **no `manifest`** → `registry.catalog()`: name, description, slots, source, for every
  layout including user templates. This is the discovery surface (D9).
- **with `manifest`** → parse → validate each slide's fields against its layout's `slots` →
  `lintDeck()` → `storyline()`.
- inline `object` + `baseDir` lets the agent lint a draft it has not written to disk.

## The load-bearing constraint

**No rendering.** No `deliver`, no `parseSvg`, no `.pptx` write. The only filesystem access
is reading the manifest and an existence check on each `ir`. Assert this with a spy on
`runArchify` that fails the test if it is called even once — a "cheap" path that quietly
renders is worse than no path, because its cost is then invisible.

## Also

Register in `extensions/archify.ts` behind the same `BUN_PI_ARCHIFY === "0"` self-gate as the
other four. Re-run `bun run --cwd bun-apps/s2-agent regen:manifest` and re-measure the
schema-cost canary — this is the first tool this package has added since the canary existed.

## Acceptance

- Catalog lists all six code layouts plus every discovered template.
- Slot validation reports the missing slot AND the template's own `description`.
- The `runArchify` spy is never called, for any input.
- Tool result is useful when a manifest is valid — the storyline, not just "ok".

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
plus `bun run --cwd bun-apps/s2-agent regen:manifest` clean.
