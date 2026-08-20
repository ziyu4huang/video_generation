---
ticket: 08-diagram-pane
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [07]
blocking: [10]
---
# 08 — webui: the Diagram pane (viewer + deck mode)

> Spec §4.5. Decision D4. Follows the `webui-simplify` pane pattern.

## What to build

In `src/render-shell.ts` (the embedded shell string), add `#deck-pane` and a `deck` branch to
`setPane`:

1. **Viewer** — a single `<iframe src="<resolved /files url>">`. Full runtime fidelity comes
   from the route's EXISTING `CSP: sandbox allow-scripts allow-downloads`; do not use
   `srcdoc`, do not add a transport, do not weaken the CSP.
2. **Deck nav** — prev/next buttons, `←`/`→` keys **only while the pane is active**, a slide
   counter, and a rail listing slide titles (clicking selects).
3. **Zoom** — `fit` (default) / `actual`, applied to the iframe wrapper.
4. **Escape hatches** — `fullscreen` (requestFullscreen on the frame) and `open standalone`
   (`window.open` from the parent, unconstrained by the sandbox). Mirrors the Report tab pair.
5. **Hash routing** — `#deck` selects the pane, `#deck-<deckId>` selects a deck.
   `#card-<id>` deep-link precedence stays **unchanged**.
6. **Replay** — rebuild the pane from `diagram_deck` / `diagram_open` frames in the snapshot;
   a refresh restores the deck and the active slide index.

## Acceptance

- `shell-syntax` and `pane-hash` tests stay green (they already exist — do not weaken them).
- New tests: pane markup present, hash routing incl. `#card-` precedence, deck nav bounds
  (no wrap past first/last), snapshot replay restores deck + index.
- Manual: an `archify_render` lands in the Diagram pane and its theme toggle / export menu
  still work inside the iframe.

## Gate

`( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun run test )`
