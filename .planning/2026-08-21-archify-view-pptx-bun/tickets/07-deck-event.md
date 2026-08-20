---
ticket: 07-deck-event
effort: archify-view-pptx-bun
type: task
status: closed
created: 2026-08-21
blocking: [08, 09]
---
# 07 — webui: `webui:deck` event + `diagram_*` frames

> Spec §4.4. Decision D6 (string-literal channel; webui imports nothing from archify).

## What to build

1. **`src/deck-event-handler.ts`** — mirrors `open-event-handler.ts` in shape and
   robustness. Payload
   `{deckId: string, title?: string, slides: {path, title?, subtitle?}[]}`.
   - Validate every `path` through the EXISTING `locateFileInRoots` (`src/file-routes.ts`) —
     reuse it, do not re-implement containment; route and event must never disagree.
   - Slides outside the roots are **dropped, not fatal**; if none survive, ignore the
     emission with a debug line.
   - Resolve each survivor to a `/files` URL with **per-segment** `encodeURIComponent`
     (the `open-event-handler` precedent).
   - NEVER throw — whole body try/catch, per the bus robustness rule.
2. **`src/protocol.ts`** — add two state-bearing frames:
   `diagram_deck {deckId, title?, slides:{url,title?,subtitle?}[], ts}` and
   `diagram_open {url, view?, title?, ts}`. Frames carry **resolved URLs only**, never raw
   paths (`webui-wiring.ts:1049` precedent).
3. **Frame diet** — add both to the web-client allowlist, and route them through the
   STORE-WRAPPED broadcaster so they ride live fan-out AND the connect-time snapshot replay.
4. **`webui:open` also emits `diagram_open`** alongside the existing `view_opened`, so a
   single archify render reaches the pane with **zero archify changes**.
5. **Wiring** — register the handler in `src/webui-wiring.ts` next to the open handler.

## Acceptance

- Unit tests: valid deck, partially-outside-roots deck (survivors kept), fully-outside deck
  (ignored), empty roots (ignored, fail closed), malformed payloads (object/array/null/
  missing slides), and a throwing `getUrl` — none of which throw.
- A `diagram_deck` frame present in the connect-time snapshot after emission.

## Gate

`( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun run test )`

## Result

**closed 2026-08-21** — `src/deck-event-handler.ts`, the `diagram_deck` frame in
`protocol.ts`, wiring in `webui-wiring.ts`, `tests/deck-event-handler.test.ts` (28 tests
covering containment, traversal, symlink escape, directories, 13 malformed payloads, a
throwing `getUrl` and a throwing `broadcast`).

**Design correction during build — `diagram_open` was NOT added.** The spec called for a new
single-diagram frame, but `view_opened` already exists, already carries
`{view, title, url, ts}`, is already broadcast for every archify render, and is already
replay-eligible. Adding a parallel frame would have been a second way to say the same thing.
The Diagram pane consumes `view_opened` directly, so single diagrams reach it with **zero
archify changes** — better than the spec's plan, not a compromise on it.
