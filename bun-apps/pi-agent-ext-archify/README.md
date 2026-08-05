# pi-agent-ext-archify

A pi agent extension that lets the agent author typed-JSON-IR technical diagrams
(architecture / workflow / sequence / data-flow / lifecycle) and render them to
self-contained, validated HTML.

Vendors archify@2.12.0 (MIT, https://github.com/tt-a1i/archify) as a pinned local
snapshot under `vendored/`. No dependency on the upstream source after vendor-copy.

**Tools:** `archify_render`, `archify_validate`, `archify_delta`.
**Skill:** `archify` (condensed; loads vendored depth on demand).

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
