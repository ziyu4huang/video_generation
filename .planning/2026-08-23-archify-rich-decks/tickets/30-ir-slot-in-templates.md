---
type: task
status: open
---

# 30 — `ir` slot in layout templates: decision / timeline-with-diagram / figure

## Question

One slide can carry a validated IR + rich template text — templates gain a first-class
`{slide.ir}` diagram binding, so "evidence + the call" is one authored slide.

## What to build

The template language's `diagram` BlockContent kind already exists and both emitters
already render it (prototype-proven 2026-08-24: a scratch `decision` template built
end-to-end, 100 native shapes / 0 blips, ZERO src changes). This ticket makes it a
shipped, tested, documented first-class slot — data + validation + tests + docs,
with the D3 lock proven (not argued):

- **3 new shipped templates** (data): `decision` (diagram 60% + call + why),
  `timeline-with-diagram` (milestones row + diagram), `figure` (caption + diagram +
  note) — all binding `{kind:"diagram", from:"{slide.ir}"}` (canvas fit — template
  ContentSpecs do not carry `fit`); slots per spec.md §7.2.1.
- **`requiresIr`** renderless validation: `loadTemplate` flags templates that bind
  `{slide.ir}`; `slotProblems` reports a missing `ir` naming the template.
- **D3/D5 proof**: no frozen constant or emitter geometry changes (the seam is already
  wired); legacy diagram-layout suites pass unchanged; new deck-composition pin for an
  ir-slot slide (0 `<a:blip>`, shape counts, `fit=content` golden, OOXML lint clean).
- **Demo + docs**: `examples/deck-general` gains 3 ir-slot slides (pinned layout order
  updated deliberately); authoring-templates.md / README / SKILL.md pointers.

## Acceptance

- [ ] The 3 templates ship in `templates/`; `tests/shipped-templates.test.ts` SHIPPED
      7→10 with one PAYLOADS entry each and regenerated
      `tests/fixtures/templates/{decision,timeline-with-diagram,figure}.txt` goldens;
      catalog + per-template role isolation green.
- [ ] An ir-slot slide builds through both emitters: deck-composition pins 0 `<a:blip>`
      + shape/text counts + OOXML lint clean on the pptx, and the composed HTML iframes
      the diagram artifact (`emit-html` spot check).
- [ ] `requiresIr` renderless check: deck-lint (no args? — no: with a manifest) reports
      "`<template>` needs an `ir`" on a slide missing it, without building; the build
      exists-check remains the backstop.
- [ ] D3 proof: `layouts.test.ts` chrome/geometry goldens + `deck-composition.test.ts`
      `examples/deck` byte-proxy pins + shape-IR goldens pass UNCHANGED; the diff
      contains no edits to `layouts.ts`, `deck-theme.ts`, `emit-pptx.ts` geometry, or
      `pptx-shapes.ts` defaults.
- [ ] `examples/deck-general` builds with the 3 new demo slides: pinned layout order in
      `tests/deck-composition.test.ts` updated deliberately; 0 blips + lint clean +
      one-folder-contract tests still green.
- [ ] Docs: `skills/archify/authoring-templates.md` (`ir` binding + `requiresIr`), README
      template list, SKILL.md pointer.
- [ ] Full `bun run test` green in `s2-agent-ext-archify`; `bun run typecheck` clean;
      no new runtime deps; `vendored/` untouched.

## Resolution

(open — write here at close)
