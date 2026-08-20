---
ticket: 09-manifest-single-source
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [05, 07]
---
# 09 — archify: one manifest, two surfaces

> Spec §4.3. Closes the loop between the browser deck and the exported deck.

## What to build

1. After a successful deck build, `lib/deck-build.ts` emits **`webui:deck`** on
   `pi.events` via the existing optional-bus pattern (`lib/open-announce.ts` — extend it,
   don't fork it): `deckId` = manifest basename sans extension, `slides[]` = the rendered
   HTML paths in manifest order with their titles/subtitles.
2. `archify_export_pptx` emits the same event, so exporting from the agent also populates the
   browser pane.
3. No webui present (or paths outside its roots) ⇒ **no-op**, and the tool result still
   prints the `.pptx` path exactly as before. archify still imports nothing from webui.

## Acceptance

- Mock-bus test: a deck build emits exactly one `webui:deck` with slides in manifest order.
- No-bus test: build succeeds, nothing thrown.
- Cross-package smoke: build `examples/deck/` with a webui whose `fileRoots` covers the
  output dir ⇒ a `diagram_deck` frame with 5 resolved `/files` URLs in the right order.

## Gate

Both package gates (§6).
