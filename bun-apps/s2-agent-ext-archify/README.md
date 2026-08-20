# s2-agent-ext-archify

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
When the s2-agent-ext-webui is present and the output lives under its configured
`WEBUI_FILE_ROOTS`, this surfaces a clickable `/files` URL in the TUI. Fully optional: no
webui (or a path outside its roots) → no-op, and the tool result still prints the output
path exactly as before. archify imports nothing from webui — the string-literal channel is
the whole contract.

With webui view-notifications (2026-08-16), a successful render ALSO lands in the browser shell — a fresh-open toast plus an entry in the views panel — still with zero webui imports.

With webui present adoption (2026-08-16), a successful render ALSO emits `webui:present` (Approve / Regenerate… with free-text tweak) — still zero webui imports; without webui both events are no-ops.

With webui event cards (2026-08-16), both emissions ALSO surface as readonly cards in the browser's Cards tab (attention `view`, clickable `/files` deep link via `#card-archify-<view>`).

## PPTX export — native, editable shapes

Turn a set of IR files into a 16:9 PowerPoint deck. Slides carry **real PowerPoint shapes and
text runs**, not screenshots: boxes are `rect`/`roundRect`, routed connectors are `custGeom`
freeforms with real quadratic/cubic curves, straight runs stay single `line` shapes with
native arrowheads, and every label is an editable text run. **No browser is involved.**

Two entry points over one core (`lib/deck-build.ts`), so the CLI and the agent cannot drift:

```bash
bun run deck [manifest] [--theme light|dark] [--output out.pptx]
             [--slides-dir <dir> | --no-slides] [--emit-shape-ir <dir>]
```

…and the registered **`archify_export_pptx`** tool (`{manifestPath | irPaths, outputPath?,
theme?, slidesDir?}`).

Manifest (`deck.config.json`, default):

```json
{
  "output": "out.pptx",
  "theme": "light",
  "tag": "archify deck",
  "defaults": { "font": "PingFang TC" },
  "slides": [{ "ir": "slide1.json", "title": "…", "subtitle": "…" }]
}
```

`ir` / `output` resolve relative to the manifest dir (portable manifest); `--output` resolves
relative to cwd. `defaults.scale` configured the old raster path — it is **accepted and
ignored** so existing manifests keep working. Each IR goes through the same `deliver` path as
`archify_render`, so a deck can never be built from an artifact archify considers broken.

**Canonical example:** `examples/deck/` — `bun run deck examples/deck/deck.config.json`
renders the 5-slide SAS/MAS Itemize deck (INCOSE × ASPICE 4.0). Measured 2026-08-21: 302 KB,
358 native shapes, zero images.

### One manifest, two surfaces

The rendered slide HTML is kept beside the `.pptx` in `<output>.slides/` (override with
`--slides-dir`, opt out with `--no-slides`). Those files ARE the diagrams — full-fidelity and
interactive — and a successful build emits **`webui:deck`** on the host bus with their paths,
which a webui renders as a browsable deck in its Diagram pane. The `.pptx` is the flattened,
portable view of the same ordered set. Webui-optional as ever: no webui, no effect.

`--thumbnails` (tool: `thumbnails: true`) additionally renders a WebP per slide for the
webui's slide rail, via `Bun.WebView` + `Bun.Image` — no browser download. Off by default
because it is wasted work when you only want a `.pptx`; measured at 1.3 s for the whole
five-slide example deck INCLUDING the build, since the engine starts once and is reused.
Generation is best-effort and cached by mtime: a failure just leaves that slide showing its
title.

### The acceptance contract

`__tests__/pptx-shapes.test.ts` builds all five diagram types and reads the `.pptx` back with
a pure-Bun ZIP reader, asserting per slide that **`<a:blip>` count is 0** — a blip is an image
reference, so zero of them means nothing was rasterized. That is the one property a
regression back to screenshots cannot fake. (`Bun.Archive` cannot read zip — probed
2026-08-21 — hence the local-header walk + `DecompressionStream("deflate-raw")`.)

### How it works

```
IR .json --deliver--> .html --parseSvg--> SvgDoc --toShapeIR--> ShapeIR --> pptxgenjs
          (validated)      (HTMLRewriter)        (+ svg-theme)
```

`ShapeIR` (`lib/shape-ir.ts`) is a format-neutral, paint-ordered shape list with transforms
applied and styles resolved — the seam any future exporter (PDF, Keynote, Figma) attaches to.
`lib/svg-model.ts` explains why `HTMLRewriter` and not `Bun.XML` (document order is paint
order, and `Bun.XML` measurably loses it). Golden fixtures for all five diagram types live in
`__tests__/fixtures/shape-ir/`; regenerate with `UPDATE_SHAPE_IR_GOLDENS=1 bun test`.

## Browsers

Neither this package nor `s2-agent-ext-webui` downloads a browser. The two tests that need a
real rendering engine — the SVG-arc ground-truth check and the mermaid paint-check — use
**`Bun.WebView`** (Bun 1.4): system WebKit on macOS, nothing to install, ~350 ms cold.

`__tests__/no-browser-deps.test.ts` keeps it that way, but only for what actually matters:
packages that **bundle a browser download** (`playwright`, `@playwright/test`, `puppeteer`)
are banned here, while `playwright-core` / `puppeteer-core` are explicitly ALLOWED — Bun 1.4
runs Playwright natively and those builds drive an already-installed Chrome over CDP with no
download at all.
