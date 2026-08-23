---
ticket: 09-manifest-single-source
effort: archify-view-pptx-bun
type: task
status: closed
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

## Result

**closed 2026-08-21** — `announceDeck`/`deckAnnounceFor` in `lib/open-announce.ts`, a
`slidesDir` option through `lib/deck-build.ts`, defaults wired into both entry points,
`__tests__/deck-announce.test.ts` (14 tests).

**Design question the ticket did not anticipate**: slide HTML was rendered into a temp dir
that the build deleted on return, so there was nothing for a webui to serve. Resolved by
PERSISTING the slides beside the .pptx in `<output>.slides/` by default
(`--slides-dir` / `--no-slides` / `slidesDir: null` opt out). That is not a side effect worth
apologising for — those files ARE the diagrams, full-fidelity and interactive; the .pptx is
their flattened, portable view. A test asserts the ANNOUNCED paths still exist after the build
returns, which is the obvious way to get this wrong.

**Cross-package smoke, run live**: `examples/deck/` built 5 slides → one `webui:deck`
emission → webui's REAL handler resolved 5 `/files` URLs in manifest order with CJK titles
intact, and a `/etc/passwd` slide injected into the same payload was dropped by containment.
That payload is now pinned verbatim as a fixture in webui's
`tests/deck-event-handler.test.ts` — the two packages import nothing from each other, so
nothing else binds archify's emission to webui's expectation.
