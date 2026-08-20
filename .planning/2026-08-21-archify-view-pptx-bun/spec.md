# Spec — archify: native-shape PPTX, in-shell diagram viewer, Bun-1.4-native

> STATUS: drafted 2026-08-21. Design approved by the user the same day. All runtime claims in
> §2 were **probed on this machine** (bun 1.4.0) — see `map.md` § Context for the raw numbers.
> Verified against `bun-apps/pi-agent-ext-archify/{lib,scripts,vendored}` and
> `bun-apps/pi-agent-ext-webui/src` at commit `adc4a8a2a`.

## §1 Goal

1. `archify` exports PPTX as **native editable shapes** — zero images in the slide XML.
2. `webui` gains a **Diagram pane**: single-diagram viewer + deck (multi-diagram) mode, in the
   shell, at full runtime fidelity.
3. Both packages run **Bun-1.4-native**: no browser binary download, no Playwright, guarded.

Non-goals: changing archify's IR schemas; editing the vendored archify snapshot; redesigning
the webui shell beyond adding one pane; replacing the `/files` route.

## §2 Background

### 2.1 What produces the pixels today

`archify_render` shells the vendored CLI (`vendored/bin/archify.mjs deliver … --json`) via
`lib/run.ts`, which spawns `process.execPath` — already Bun. The product is a **self-contained
HTML** file: an inline `<svg>` plus a large template runtime (theme toggle, hover-trace,
semantic nav, export menu). Measured: the committed sample artifact is **629 KB total, of
which the `<svg>` is 54 KB**.

`scripts/deck.ts` is the only PPTX path today and the only browser dependency in the package:
it launches Playwright chromium, screenshots the `<svg>`, and `addImage`s the PNG onto a
16:9 slide. Output slides are therefore flat pictures.

### 2.2 Why the SVG is exportable as shapes

The emitted SVG uses a bounded vocabulary (`rect`, `text`, `g`, `path`, `circle`, `ellipse`,
`polygon`, `marker`, `defs`, `pattern`, `title`), path `d` limited to `M L Q Z V H` + relative
`m l c s v h`, and styling entirely by CSS class (31 classes defined in
`vendored/assets/template.html`, 28 used by the sample). `pptxgenjs@4.0.1` exposes `custGeom`
with quadratic/cubic/arc curve points, so even rounded routed connectors map to real shapes.

### 2.3 What webui already owns

`locateFileInRoots` (`src/file-routes.ts`) is the shared containment core behind BOTH the
`/files` route and the `webui:open` handler — deliberately shared so route and event can never
disagree about what is servable. `/files` answers with
`Content-Security-Policy: sandbox allow-scripts allow-downloads` + `nosniff`, giving the served
document an opaque origin (scripts run; `/api` and the WS are unreachable from it). A
`view_opened` frame exists and is broadcast + replayed, but no pane renders it.

## §3 Decisions

Recorded in full in `map.md` § Decisions (D1–D6). The two that shaped the architecture:

- **D2 — `HTMLRewriter`, not `Bun.XML`.** `Bun.XML.parse` collapses children into a
  tag-name-keyed map, losing document order across differing sibling tags. Document order is
  paint order in SVG, so this is a correctness disqualifier, not a preference. It also cannot
  parse archify's HTML-style boolean attributes at all. Measured evidence in `map.md`.
- **D5 — `Bun.WebView`, and Playwright removed.** Because WebView works headless here with
  nothing to install, dropping Playwright costs no coverage — the mermaid render test keeps
  executing a real engine.

## §4 Design

### 4.1 The ShapeIR seam (archify, new)

One format-neutral intermediate representation sits between parsing and exporting. Everything
upstream of it knows only SVG; everything downstream knows only ShapeIR.

```
rendered .html ──▶ lib/svg-model.ts ──▶ lib/shape-ir.ts ──▶ lib/pptx-shapes.ts ──▶ .pptx
                   (HTMLRewriter)        (+ svg-theme.ts)      (pptxgenjs)
```

**`lib/svg-model.ts`** — `parseSvg(html: string): SvgDoc`.
Streams the whole HTML through one `HTMLRewriter` pass (`.on("svg, svg *")`), emitting an
ordered `SvgNode[]` in document order with a depth stack. Each node carries `tag`, lowercase
`attrs`, `depth`, accumulated `text`, and the **resolved absolute transform** (a 2×3 matrix
composed down the `<g transform>` chain). `viewBox` is read as `viewbox` (D2 quirk). Nodes
under `<defs>` are retained but flagged `defOnly` so markers/patterns are addressable without
being painted.

**`lib/svg-theme.ts`** — `resolveStyle(classList, theme): Style`.
A pinned table mapping archify's class vocabulary to `{fill, stroke, strokeWidth, dash,
color, fontWeight, opacity}` for `light` and `dark`. Inline presentation attributes on the
node win over the class table (archify sets `stroke-width`, `font-size`, `font-weight`,
`text-anchor` inline). See §5.2 for the drift guard.

**`lib/shape-ir.ts`** — `toShapeIR(doc: SvgDoc, theme): ShapeIR`.
Normalizes into one flat, paint-ordered array in SVG user units:

```ts
type ShapeNode =
  | { kind: "rect"; x; y; w; h; rx?; style }
  | { kind: "ellipse"; cx; cy; rx; ry; style }
  | { kind: "polygon"; points: Pt[]; style }
  | { kind: "path"; segments: Seg[]; closed: boolean; style }   // M/L/Q/C/A, absolutized
  | { kind: "text"; x; y; text; anchor: "start"|"middle"|"end"; fontSize; fontWeight; style };
interface ShapeIR { width: number; height: number; theme: "light"|"dark"; nodes: ShapeNode[] }
```

Responsibilities: absolutize relative path commands, apply each node's resolved transform to
its geometry, drop non-visual nodes (`title`, `desc`, `defs` subtree, the `url(#grid)`
background plate), and preserve array order = paint order.

### 4.2 ShapeIR → PPTX (archify, new)

`lib/pptx-shapes.ts` — `addShapeIrToSlide(slide, ir, box)` where `box` is the content
rectangle in inches. One uniform scale `s = min(box.w/ir.width, box.h/ir.height)` with
centering, so aspect ratio is preserved.

| ShapeIR | pptxgenjs |
|---|---|
| `rect` with `rx` | `addShape("roundRect", {rectRadius})` |
| `rect` without `rx` | `addShape("rect")` |
| `ellipse` | `addShape("ellipse")` |
| `polygon` | `addShape("custGeom", {points, close:true})` |
| `path` (2 points, no curve) | `addShape("line")` + `endArrowType` when a marker is referenced |
| `path` (otherwise) | `addShape("custGeom")`; `Q`→`curve:{type:"quadratic"}`, `C`→`cubic`, `A`→`arc` |
| `text` | `addText` with a box derived from `anchor` + `fontSize`, `align` from `anchor` |

Arrowheads: archify draws them as `<marker><polygon>` in `<defs>` referenced by
`marker-end`. Simple 2-point connectors use pptx's native `endArrowType` (stays editable as
one line); multi-segment routes emit the arrowhead polygon as its own `custGeom` at the
computed terminal angle.

Text placement is derived from SVG anchor geometry, **not** measured glyph advances. Charted
fallback if real decks overflow: a `Bun.WebView` metrics pass (fog, `map.md`).

### 4.3 Deck manifest = one source of truth

The existing `deck.config.json` shape is kept (back-compatible): `{output, theme, tag,
defaults:{font,scale}, slides:[{ir,title,subtitle}]}`. `scale` loses its meaning (no raster)
and is accepted-and-ignored. The same manifest drives BOTH the `.pptx` and the webui deck
view, so a deck previewed in the browser and a deck exported to PowerPoint are the same
ordered set by construction.

Two entry points, one core (`lib/deck-build.ts`):

- `bun run deck [manifest] [--theme] [--output]` — unchanged CLI surface.
- **`archify_export_pptx`** — a new registered tool (`{manifestPath?, irPaths?, outputPath?,
  theme?}`). This promotes `pptxgenjs` from `devDependencies` to `dependencies`; the
  schema-cost canary measures the extension automatically (no `EXTRA_ENTRIES` row needed).

### 4.4 webui: the `webui:deck` event

New event on the shared bus, same optional-emit contract as `webui:open` (D6):

```ts
{ deckId: string; title?: string; slides: { path: string; title?: string; subtitle?: string }[] }
```

`src/deck-event-handler.ts` validates each `path` through the **existing**
`locateFileInRoots` — slides outside the roots are dropped, not fatal; an empty surviving set
ignores the emission. It never throws (bus robustness rule). Resolved slides become a
`diagram_deck` frame carrying already-resolved `/files` URLs (never raw paths — the
`view_opened` precedent at `webui-wiring.ts:1049`).

Protocol additions (`src/protocol.ts`), both state-bearing and therefore replay-eligible via
the store-wrapped broadcaster, and both added to the web-client frame diet:

```ts
| { type: "diagram_deck"; deckId: string; title?: string;
    slides: { url: string; title?: string; subtitle?: string }[]; ts: number }
| { type: "diagram_open"; url: string; view?: string; title?: string; ts: number }
```

`diagram_open` is emitted by the EXISTING `webui:open` handler alongside `view_opened`
(single-diagram case) so one archify render lands in the pane without archify changing.

### 4.5 webui: the Diagram pane

`src/render-shell.ts` gains `#deck-pane` and a `deck` branch in `setPane`, following the
`webui-simplify` pane pattern:

- **Viewer**: one `<iframe src="<resolved /files url>">` — full runtime fidelity under the
  route's existing CSP. No `srcdoc`, no new transport, no new security surface.
- **Deck nav**: prev/next buttons, `←`/`→` keys when the pane is active, slide counter, and a
  slide rail listing titles (thumbnails arrive in ticket 10).
- **Zoom**: `fit` (default) and `actual`, applied to the iframe wrapper.
- **Escape hatches**: `fullscreen` (requestFullscreen on the frame) and `open standalone`
  (`window.open` from the parent — no sandbox constraint), mirroring the Report tab's proven
  pair.
- **Hash routing**: `#deck` selects the pane; `#deck-<deckId>` selects a deck. Existing
  `#card-<id>` precedence is preserved unchanged.
- **Replay**: both frames ride the connect-time snapshot, so a refresh restores the deck and
  the active slide index.

### 4.6 Bun-native cleanup

- `__tests__/architecture-mermaid.test.ts` moves from Playwright chromium to `Bun.WebView`
  (`navigate` a `file://` URL → `evaluate` that mermaid produced an `<svg>` → optional
  `screenshot`). Coverage is **kept**, not downgraded.
- `playwright` leaves `devDependencies`; `scripts/deck.ts` loses its `chromium` import.
- File I/O in touched archify files moves to `Bun.file` / `Bun.write`. The vendored snapshot
  is NOT touched.
- Out of scope: `pi-agent-ext-power-tool` and `gui-movie-director` also use Playwright. They
  are unaffected and, post-Bun-1.4, no longer a pure-Bun problem.

## §5 Testing

### 5.1 The acceptance test that defines "shape design"

`__tests__/pptx-shapes.test.ts` builds a deck from the vendored examples for **all five**
diagram types, then reads the `.pptx` **in pure Bun** — a ~25-line ZIP local-file-header
walker + `DecompressionStream("deflate-raw")` (measured working) — and asserts per slide:

- `<a:blip>` occurrences **= 0** (nothing was rasterized), and
- `<a:sp>` occurrences **≥ the ShapeIR node count for that slide**, and
- every ShapeIR `text` node's string appears in the slide XML.

The first assertion is the one that cannot be satisfied by regressing to images.

### 5.2 Guards

- `__tests__/theme-drift.test.ts` — scan `vendored/assets/template.html` plus every rendered
  vendored example; every `class` token encountered on a painted element must exist in the
  `svg-theme` table. A vendored bump that adds a class fails loudly instead of silently
  exporting an unstyled shape.
- `__tests__/no-browser-deps.test.ts` — no `playwright` / `puppeteer` / `chromium` in either
  package's `package.json` or source imports.
- `__tests__/svg-model.test.ts` — golden node-count + order assertions against the committed
  629 KB artifact (the 359-node census is the baseline).
- ShapeIR golden fixtures per diagram type, so a vendored renderer change surfaces as a
  reviewable IR diff rather than a silently different deck.

### 5.3 webui

Unit tests for `deck-event-handler` (valid / outside-roots / empty-roots / malformed / never
throws), protocol frame shape, shell pane markup + hash routing, and snapshot replay of
`diagram_deck` — matching the existing `open-event-handler` / `pane-hash` test patterns.

## §6 Gates

```bash
( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )
( cd bun-apps/pi-agent-ext-webui   && bun run typecheck && bun run test )
```

Per `CLAUDE.md`, each package's canonical `bun run test` is the gate — never a hand-assembled
subset. `bun install` must be run from `bun-apps/` (no `node_modules` present at effort start).

## §7 Risks

| Risk | Mitigation |
|---|---|
| Text overflows its PPTX box (no glyph metrics) | Anchor-derived boxes + generous padding; charted `Bun.WebView` metrics fallback (§4.2) |
| A vendored bump adds SVG classes or path commands | `theme-drift` guard (§5.2) + ShapeIR goldens; unknown path commands fail loudly rather than silently dropping geometry |
| `HTMLRewriter` attribute lowercasing surprises a future reader | Single documented normalization point in `svg-model.ts`; the quirk is recorded in `map.md` and D2 |
| Adding a pane destabilizes the 1695-line shell string | Follow the `webui-simplify` `setPane` pattern; `shell-syntax` + `pane-hash` tests already exist and must stay green |
| `archify_export_pptx` inflates the registered bundle | Accepted: one tool, one dependency promotion; the schema-cost canary measures it automatically |
