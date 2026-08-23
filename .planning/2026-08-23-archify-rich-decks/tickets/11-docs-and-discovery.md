---
type: task
blocking: 10
status: closed
---

# 11 — Discovery & docs: IR library in the no-args lint catalog + docs index

## Question
An authoring agent discovers the IR library at the same surface it already discovers
layouts and deck skeletons — and the docs point at it.

## What to build

`archify_deck_lint` with no manifest (the existing catalog surface, `src/deck-lint-tool.ts`
D9) additionally reports the IR library from `library.catalog.json` — per entry:
diagram_type · title · description · suggested pairing · path. No new tool, no registry
change (schema-cost canary rule). Docs: README + `skills/archify/deck.md` pointer paragraph,
`skills/archify/SKILL.md` on-demand depth list gains the library path.

## Acceptance

- [x] `archify_deck_lint` (no manifest) output includes an IR-library section listing every
      cataloged IR with type, title, description, pairing and path (details.irLibrary).
- [x] Manifest-mode lint behavior unchanged (same diagnostics, same exit semantics; the
      existing 18 deck-lint tests still pass).
- [x] README / deck.md / SKILL.md updated with the library pointer.
- [x] `bun run test` green (670 pass / 21 skip / 0 fail); no new tool entries (schema-cost
      canary unaffected).

## Resolution

Shipped on `archify-rich-decks-ir-library` (PR pending): `loadIrLibrary()` +
`IrLibraryEntry` in `src/deck-lint-tool.ts` (missing-file-safe, mirroring the skeleton
`shippedDir` seam), the IR-library section in the no-args catalog surface (text +
`details.irLibrary`), tool description updated, docs pointers in README / deck.md / SKILL.md,
and the discovery test pinned (D9 describe).
closed: 2026-08-23 (implemented)
