# pi-agent-ext-archify

A pi agent extension that lets the agent author typed-JSON-IR technical diagrams
(architecture / workflow / sequence / data-flow / lifecycle) and render them to
self-contained, validated HTML.

Vendors archify@2.12.0 (MIT, https://github.com/tt-a1i/archify) as a pinned local
snapshot under `vendored/`. No dependency on the upstream source after vendor-copy.

**Tools:** `archify_render`, `archify_validate`, `archify_delta`.
**Skill:** `archify` (condensed; loads vendored depth on demand).

## `webui:open` announce (webui-optional)

A successful `archify_render` / `archify_delta` emits `webui:open` on the host event bus
(`lib/open-announce.ts`) — `{ path, view, title }` where `view` is the output basename
sans `.html` (delta: `compare-<basename>`) and `title` is `ir.meta.title ?? diagramType`.
When the pi-agent-ext-webui is present and the output lives under its configured
`WEBUI_FILE_ROOTS`, this surfaces a clickable `/files` URL in the TUI. Fully optional: no
webui (or a path outside its roots) → no-op, and the tool result still prints the output
path exactly as before. archify imports nothing from webui — the string-literal channel is
the whole contract.

With webui view-notifications (2026-08-16), a successful render ALSO lands in the browser shell — a fresh-open toast plus an entry in the views panel — still with zero webui imports.

With webui present adoption (2026-08-16), a successful render ALSO emits `webui:present` (Approve / Regenerate… with free-text tweak) — still zero webui imports; without webui both events are no-ops.

With webui event cards (2026-08-16), both emissions ALSO surface as readonly cards in the browser's Cards tab (attention `view`, clickable `/files` deep link via `#card-archify-<view>`).

## Deck builder (`bun run deck`)

Turn a set of IR files into a 16:9 PowerPoint deck — one diagram per slide with
title / accent / footer chrome. Bun-native (`pptxgenjs` + Playwright); **dev-only**
(not part of the registered extension bundle — `extensions/archify.ts` is untouched).

```bash
bun run deck [manifest] [--theme light|dark] [--output out.pptx]
```

Manifest (`deck.config.json`, default):

```json
{
  "output": "out.pptx",
  "theme": "light",
  "tag": "archify deck",
  "defaults": { "font": "PingFang TC", "scale": 2 },
  "slides": [{ "ir": "slide1.json", "title": "…", "subtitle": "…" }]
}
```

`ir` / `output` resolve relative to the manifest dir (portable manifest);
`--output` resolves relative to cwd. Each IR is rendered via the same `deliver`
path as `archify_render` (validated, not just rendered). Light + dark themes.
See `docs/2026-08-03-deck-design.md` for the full design.

**Canonical example:** `examples/deck/` — `bun run deck examples/deck/deck.config.json`
renders the 5-slide SAS/MAS Itemize deck (INCOSE × ASPICE 4.0).
