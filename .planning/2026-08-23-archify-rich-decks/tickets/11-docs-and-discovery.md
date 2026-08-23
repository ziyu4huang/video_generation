---
type: task
blocking: 10
status: open
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

- [ ] `archify_deck_lint` (no manifest) output includes an IR-library section listing every
      cataloged IR with type, title, description, pairing and path.
- [ ] Manifest-mode lint behavior unchanged (same diagnostics, same exit semantics).
- [ ] README / deck.md / SKILL.md updated with the library pointer.
- [ ] `bun run test` green; no schema-cost canary regression (no new tool entries).
