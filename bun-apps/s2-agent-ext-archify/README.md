# s2-agent-ext-archify

A pi agent extension that lets the agent author typed-JSON-IR technical diagrams
(architecture / workflow / sequence / data-flow / lifecycle), render them to
self-contained validated HTML, and **compose them into a meeting deck** — six slide
layouts emitted as both a native-shape `.pptx` and browsable slide HTML.

Vendors archify@2.12.0 (MIT, https://github.com/tt-a1i/archify) as a pinned local
snapshot under `vendored/`. No dependency on the upstream source after vendor-copy.

**Tools:** `archify_render`, `archify_validate`, `archify_delta`, `archify_export_pptx`, `archify_deck_lint`.
**Skill:** `archify` (condensed; loads vendored depth on demand).

## `webui:open` announce (webui-optional)

A successful `archify_render` / `archify_delta` emits `webui:open` on the host event bus
(`src/open-announce.ts`) — `{ path, view, title }` where `view` is the output basename
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

Two entry points over one core (`src/deck-build.ts`), so the CLI and the agent cannot drift:

```bash
bun run deck [manifest] [--theme light|dark] [--output out.pptx]
             [--slides-dir <dir> | --no-slides] [--emit-shape-ir <dir>]
bun run deck render <manifest> [--out <dir>] [--size <px>]
```

`deck render` pictures every slide as `slide-N.png` through the first available
backend (Quick Look on macOS, LibreOffice elsewhere) — an on-demand command for
human eyes, never a build gate; with no backend it exits non-zero naming what it
looked for (`src/deck-render.ts`).

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

## Slide layouts — a deck, not a pile of exhibits

A slide is no longer "one diagram per page". Six layouts:

| `layout` | what it is | fields it reads |
|---|---|---|
| `title` | cover | `eyebrow`, `title`, `subtitle`, `date` |
| `section` | chapter divider | `sectionNumber`, `title` |
| `bullets` | one bullet column (2 levels) | `title`, `takeaway`, `bullets`, `source` |
| `split` | diagram left, points right, **60/40** | `ir`, `bullets`, `ratio`, + chrome |
| `diagram` | full-width diagram | `ir`, + chrome |
| `statement` | one large claim | `statement`, `attribution` |

```json
{ "layout": "split", "ratio": 0.6,
  "title": "Cold-path latency, not the hot path, is what users feel",
  "takeaway": "Cache the resolver and p99 halves",
  "source": "prod traces, 2026-07",
  "ir": "trace.dataflow.json",
  "bullets": ["p99 is 4.2 s", { "text": "3.1 s of it is DNS", "level": 1 }] }
```

**Every manifest written before layouts existed still builds, unedited.** A slide with `ir`
and no `layout` IS a diagram slide, and that layout reproduces the pre-composition chrome to
the coordinate — verified by rebuilding `examples/deck/` and comparing the slide XML **byte
for byte** against a pre-refactor capture (all five identical; see `receipts/`).

Field names follow consulting practice on purpose. `title` is an **action title** — the
takeaway as a complete claim, not a topic label — because stacked action titles are what let
a deck be read from the titles alone. `bun run deck --lint` prints exactly that stack, plus
advisory notes (label-ish title, >6 bullets, nesting past level 1, a literal `#rrggbb` in
copy) and the OOXML diagnostics for the file just written. It never changes the exit code.

One content rule is **not** advisory. A title wider than its band wraps onto a second line,
and the accent rule sits at a fixed `y` — so line two comes out struck through and clipped.
`src/text-extent.ts` predicts that wrap from the band width and the type size without
measuring a glyph or opening a renderer (buckets calibrated against rendered ink, accurate to
±2 %), and `buildDeck` refuses to write a deck that trips it. Everything else stays a note.

**Canonical example:** `examples/deck-composed/` exercises all six —
`bun run deck examples/deck-composed/deck.config.json --lint`.

**Library proof deck:** `examples/deck-general/` exercises every shipped
`*.layout.json` template next to the code layouts —
`bun run deck examples/deck-general/deck.config.json --lint`.

### Layout templates — a layout dropped in, not coded in

The six above are code. More layouts arrive as **data** — a `*.layout.json` on the search path
(whose precedence is code → `$ARCHIFY_TEMPLATES` → `<manifestDir>/templates/` → packaged tier)
adds a layout with zero `.ts` change. The discovery surface is `archify_deck_lint` with **no
arguments**: it lists every layout (code + template) and every ready-to-fill deck skeleton
(`templates/decks/*.outline.md`) with its description, slots and source path. Ask it before
guessing a layout name — the set is data and can change under you. How to author a template:
`skills/archify/authoring-templates.md`.

### The outline door

A deck that is mostly prose plus a few templates can be authored as Markdown instead of
manifest JSON — `archify_export_pptx` takes `outline`/`outlinePath`, `bun run deck <file>.md
--outline` reads it. Markers cover the six code layouts (`#`, `## NN`, `###`, `^`, `~`, `-`,
`!ir`); a layout template always arrives through a fenced `:::<name>` JSON payload. The dialect
is documented in `skills/archify/deck.md`.

## Text is a real text box

`src/pptx-shapes.ts` places diagram labels at fixed coordinates with `wrap: false`: the
renderer already chose those line breaks. Composed slides are the opposite problem, so
`src/emit-pptx.ts` emits genuine PowerPoint text boxes that wrap and autofit — which is what
makes a CJK deck usable at all.

Neither emitter measures text, and that is the design, not a shortcut: this package has no
layout engine (zero browser dependencies, guarded). **A block declares a box; the target
environment wraps inside it** — PowerPoint in a text box, CSS in a positioned div. So the
same `PlacedBlock[]` drives both outputs and they cannot disagree.

```
Slide --resolveLayout--> layouts.ts --> PlacedBlock[] (boxes as stage fractions)
                                            |
       diagram blocks --deliver--> .html --parseSvg--> ShapeIR --┐
                                            |                     |
                                            +--> emit-pptx.ts  <--+
                                            +--> emit-html.ts
```

A `diagram` slide's `slide-N.html` stays **the archify artifact itself**, so the webui
Diagram pane keeps serving a full-fidelity interactive file. Composed slides get their own
page; a `split`'s diagram is iframed from a sibling artifact with `?embed=1&theme=…` — the
artifact's own documented contract, which drops its toolbar and matches the deck theme.

## OOXML validity

`src/ooxml-lint.ts` checks a built `.pptx` structurally: `[Content_Types].xml` covers every
part, every `r:id` resolves in its `.rels`, EMU coordinates are integers in range, `p:spPr`
and `a:custGeom` children follow their schema sequences, `a:rPr/@sz` is inside
ST_TextFontSize, and every `a:path` opens with `a:moveTo`. Both example decks: **0
diagnostics**, ~17 ms.

A full ECMA-376 XSD run is a one-off receipt rather than a gate — see
`receipts/archify-slide-composition-2026-08-21.md`, including the single real deviation it
found (an upstream pptxgenjs element-ordering choice) and why it is not being fixed.

**Canonical example:** `examples/deck/` — `bun run deck examples/deck/deck.config.json`
renders the 5-slide SAS/MAS Itemize deck (INCOSE × ASPICE 4.0). Measured 2026-08-21: 302 KB, **388 native shapes**,
zero images. (It read 358 before composition — the old counter reported only what the
diagram placed and never counted the chrome's 2 shapes + 4 text runs per slide. Same
slide, honest total.)

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

`tests/pptx-shapes.test.ts` builds all five diagram types and reads the `.pptx` back with
a pure-Bun ZIP reader, asserting per slide that **`<a:blip>` count is 0** — a blip is an image
reference, so zero of them means nothing was rasterized. That is the one property a
regression back to screenshots cannot fake. (`Bun.Archive` cannot read zip — probed
2026-08-21 — hence the local-header walk + `DecompressionStream("deflate-raw")`.)

### How it works

```
IR .json --deliver--> .html --parseSvg--> SvgDoc --toShapeIR--> ShapeIR --> pptxgenjs
          (validated)      (HTMLRewriter)        (+ svg-theme)
```

`ShapeIR` (`src/shape-ir.ts`) is a format-neutral, paint-ordered shape list with transforms
applied and styles resolved — the seam any future exporter (PDF, Keynote, Figma) attaches to.
`src/svg-model.ts` explains why `HTMLRewriter` and not `Bun.XML`. Re-measured 2026-08-21 on
bun 1.4.0, the picture is sharper than "Bun.XML loses order":

| | `Bun.XML.parse` | `HTMLRewriter` |
|---|---|---|
| 49 KB slide, 50-run mean | **0.229 ms** | 0.335 ms |
| order across *distinct* sibling tags | preserved (key insertion order) | preserved |
| order across *repeated* sibling tags | **lost, irrecoverably** | preserved |

`moveTo, lnTo, quadBezTo, lnTo` reads back as `{moveTo, lnTo:[…,…], quadBezTo}` — the 4th
segment folded into the 2nd's array. Four `preserveOrder`-style spellings are silently
accepted no-ops. SVG siblings repeat constantly, so `HTMLRewriter` stays; OOXML's `spPr`
children are all distinct, so `ooxml-lint` uses the faster parser there and streams only the
path-segment rule. Golden fixtures for all five diagram types live in
`tests/fixtures/shape-ir/`; regenerate with `UPDATE_SHAPE_IR_GOLDENS=1 bun test`.

## Browsers

Neither this package nor `s2-agent-ext-webui` downloads a browser. The two tests that need a
real rendering engine — the SVG-arc ground-truth check and the mermaid paint-check — use
**`Bun.WebView`** (Bun 1.4): system WebKit on macOS, nothing to install, ~350 ms cold.

`tests/no-browser-deps.test.ts` keeps it that way, but only for what actually matters:
packages that **bundle a browser download** (`playwright`, `@playwright/test`, `puppeteer`)
are banned here, while `playwright-core` / `puppeteer-core` are explicitly ALLOWED — Bun 1.4
runs Playwright natively and those builds drive an already-installed Chrome over CDP with no
download at all.
