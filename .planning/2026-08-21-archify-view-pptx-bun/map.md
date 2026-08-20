---
effort: archify-view-pptx-bun
created: 2026-08-21
last: 2026-08-21
status: active
---
# archify-view-pptx-bun — native-shape PPTX, in-shell diagram viewer, Bun-1.4-native

## Destination

Three outcomes across `bun-apps/pi-agent-ext-archify` and `bun-apps/pi-agent-ext-webui`:

1. **PPTX export as native editable shapes** — a `.pptx` whose slides contain real
   PowerPoint shapes and text runs, not a screenshot. Editable after export.
2. **A first-class diagram surface in the webui shell** — a Diagram pane with a single-file
   viewer AND a deck (multi-diagram) mode, instead of only a `webui:open` link that opens a
   separate top-level browser tab.
3. **Bun-1.4-native across both packages** — no browser binary download, no Playwright, with
   a structural guard so the dependency cannot creep back.

## Context (measured 2026-08-21, not quoted from release notes)

Local runtime is **bun 1.4.0**. Every claim below was probed on this machine.

- **`Bun.WebView` works headless here** — 356 ms cold start; `navigate` / `evaluate` /
  `screenshot` (returns a `Blob`, 18 KB PNG for a trivial page) all succeeded. macOS uses the
  system WebKit, so there is **nothing to install**. This is what makes dropping Playwright
  free rather than a trade.
- **Playwright itself now runs on Bun** (Bun 1.4: `connectOverCDP()`, `playwright test`,
  `playwright.config.ts`, `--ui`, Chromium on Windows). So "keep Playwright" would no longer
  violate the pure-Bun goal — it is simply heavier than `Bun.WebView` for what this repo needs.
- **`Bun.XML.parse` is DISQUALIFIED for SVG.** Two measured reasons:
  1. archify emits HTML-style boolean attributes in its SVG (`data-detail-anchor` on `<text>`,
     `data-legend-bridge` on `<g>`), which are not legal XML → immediate parse error.
  2. Fatal even after normalizing those: it collapses children into a **tag-name-keyed map**,
     so document order across differing sibling tags is LOST —
     `parse('<svg><rect id=r1/><path id=p1/><rect id=r2/></svg>')` yields
     `{"svg":{"rect":[{"@id":"r1"},{"@id":"r2"}],"path":{"@id":"p1"}}}`. In SVG, document
     order **is** paint order; losing it means background plates cover nodes and labels get
     occluded. A `preserveOrder`-style option was probed (4 spellings) — none exists.
- **`HTMLRewriter` is the right parser.** Streaming ⇒ document order is a structural
  guarantee. Measured on the committed 629 KB artifact
  `pi-agent-ext-archify/ir/pi-agent-ext-webui-v31.architecture.html`: **359 element nodes in
  2.31 ms**, exactly matching an independent census (99 text + 88 rect + 73 g + 48 path +
  22 title + 14 circle + 4 marker + 4 polygon + 3 ellipse + svg + desc + defs + pattern =
  359) — nothing dropped, nesting depth correct, text content captured. One quirk: attribute
  names are lowercased (`viewBox` → `viewbox`, `markerWidth` → `markerwidth`); values are
  untouched. We read a fixed small attribute set, so lowercase lookups fully absorb it.
- **`Bun.Archive` cannot read zip** — probed with bytes / `Bun.file` / path: all
  `Unrecognized archive format`; a `.tgz` was accepted. Since `.pptx` IS a zip, the acceptance
  test uses a ~25-line local-file-header walker + `DecompressionStream("deflate-raw")`,
  **measured working** (round-tripped a zip's entries and contents).
- **archify SVG is a small, bounded vocabulary** — elements: `rect`, `text`, `g`, `path`,
  `title`, `circle`, `marker`, `polygon`, `ellipse`, `defs`, `pattern`. Path `d` commands
  observed: `M L Q Z V H` and relative `m l c s v h`. Styling is entirely by CSS class
  (`c-*` component, `t-*` text, `m-*` marker, `a-*` arrow, `s-*`, `sigil-*`) — **31 classes
  defined in `vendored/assets/template.html`, 28 used** by the sample artifact.
- **`pptxgenjs@4.0.1` supports `custGeom`** with `points[]` accepting
  `{curve:{type:'quadratic'|'cubic'|'arc', …}}` and `close` — verified in its bundled
  `types/index.d.ts`. Routed connectors with rounded corners therefore map to real editable
  freeform shapes, not images.
- **Current PPTX path is `scripts/deck.ts`** — dev-only, Playwright-rasterizes each `<svg>` to
  PNG and `addImage`s it. It is also the ONLY browser dependency in the archify package.
- **webui already owns the hard parts.** `locateFileInRoots` (`src/file-routes.ts`) is already
  the SHARED containment core used by both the `/files` route and the `webui:open` handler —
  a deck handler reuses it as-is. `/files` responses carry
  `CSP: sandbox allow-scripts allow-downloads`, so archify's runtime executes but the document
  has an opaque origin. A `view_opened` frame already exists in `protocol.ts` and is
  broadcast + replayed, but **the shell does not render it** (it only surfaces as a card) —
  the Diagram pane is genuinely new UI. Panes are a hand-rolled switch in `setPane`
  (`src/render-shell.ts`) over a small fixed set, so adding one is contained.
- **`marked` is a dependency of BOTH packages**; Bun 1.4 ships `Bun.markdown`. archify's
  `lib/architecture-render.ts` builds a bespoke block model on marked's tokenizer and is
  pinned by a golden fixture, so this is deliberately kept OFF the main line (ticket 13).

## Tickets

Phase 1 — ShapeIR (archify)
- `tickets/01-svg-model.md` — task, **closed** — HTMLRewriter → ordered node list + transforms
- `tickets/02-svg-theme.md` — task, **closed** — class→style token table + drift guard
- `tickets/03-shape-ir.md` — task, **closed** — node list → normalized ShapeIR + goldens

Phase 2 — native-shape PPTX (archify)
- `tickets/04-pptx-mapper.md` — task, **closed** — ShapeIR → pptxgenjs primitives
- `tickets/05-deck-rewrite-and-tool.md` — task, **closed** — browser-free deck + `archify_export_pptx`
- `tickets/06-pptx-acceptance.md` — task, **closed** — pure-Bun zip assertion, all 5 types

Phase 3 — webui Diagram pane
- `tickets/07-deck-event.md` — task, **closed** — `webui:deck` event + handler + frame
- `tickets/08-diagram-pane.md` — task, **closed** — shell pane: viewer, deck nav, hash, replay

Phase 4 — one manifest, two surfaces
- `tickets/09-manifest-single-source.md` — task, **closed** — archify emits `webui:deck`
- `tickets/10-thumbnails.md` — task — `Bun.Image` slide rail thumbnails

Phase 5 — Bun-native + guards + docs
- `tickets/11-webview-migration.md` — task, **closed** — mermaid test → `Bun.WebView`; drop playwright
- `tickets/12-guard-and-docs.md` — task, **closed** — browser-download guard + READMEs + map sync
- `tickets/13-fog-bun-markdown.md` — decision, open (fog) — is `Bun.markdown` worth the churn?

## Decisions

- **D1 — PPTX fidelity = native editable shapes.** SVG → ShapeIR → pptxgenjs
  `rect`/`roundRect`/`ellipse`/`custGeom`/`text`. No raster path, no image fallback. Chosen
  over "shapes + raster fallback" and "shapes + SVG backup layer" (user, 2026-08-21).
- **D2 — parser = `HTMLRewriter`, NOT `Bun.XML`, NOT a hand-written tokenizer.** Order
  preservation is a correctness requirement (paint order); `Bun.XML` measurably loses it and
  additionally cannot parse archify's boolean attributes. A hand-written tokenizer was the
  fallback plan and is no longer needed. Attribute-name lowercasing is absorbed by
  lowercase lookups over a fixed attribute set.
- **D3a (build correction, 2026-08-21) — presentation properties are inherited parent→child,
  as real SVG does it.** The first cut inherited only `color`; archify's semantic sigils are
  unclassed shapes whose entire paint comes from the `.semantic-sigil` group above them, so
  that cut rendered every glyph invisible. `vector-effect: non-scaling-stroke` is honored for
  those children too. See ticket 02's Result.
- **D3 — styling = pinned token table, NOT a CSS engine.** The class vocabulary is bounded
  (31 defined / 28 used). Resolving the template's CSS would mean implementing cascade +
  custom properties + theme switching. A hand-maintained table also makes the PPTX palette
  directly controllable; a drift test makes divergence loud.
- **D4 — view surface = in-shell Diagram pane + deck mode** (user, 2026-08-21). Built on the
  EXISTING `/files` route inside an iframe — full runtime fidelity, no new transport, no new
  security surface.
- **D5 — browser = `Bun.WebView`, and Playwright is removed.** Not a trade any more: WebView
  keeps the mermaid render-fidelity coverage AND drops the devDep + the chromium download.
- **D6a (build correction, 2026-08-21) — no `diagram_open` frame.** The spec planned one for
  single diagrams; `view_opened` already carries exactly that payload, is already broadcast
  per render, and is already replay-eligible. Single diagrams reach the Diagram pane with zero
  archify changes. See ticket 07's Result.
- **D6 — cross-package contract unchanged.** archify imports nothing from webui; the
  string-literal event channel (`webui:open`, new `webui:deck`) is the entire contract.
  Absent webui ⇒ every emit is a no-op.

## Frontier

Ticket 10 (slide-rail thumbnails) — the only build item left, and explicitly the lowest
priority in the effort: the pane is fully usable with a title-only rail. Tickets 01-09 and
11-12 closed 2026-08-21.

Delivered: PPTX export is native editable shapes (the 5-slide example deck is 358 shapes with
`<a:blip>` count 0 on every slide); the PPTX path no longer touches a browser; the webui
Diagram pane renders artifacts at full runtime fidelity in-shell (verified live through the
real `/files` route in `Bun.WebView`); one manifest feeds both surfaces; and no browser
download remains in either package, guarded.

## Fog of war

- Ticket 13 (`Bun.markdown` vs `marked`) — deliberately uncharted; touches a golden fixture.
- Text metrics: PPTX text boxes are placed from SVG anchor geometry, not measured glyph
  advances. If real decks show label overflow, a `Bun.WebView`-measured metrics pass is the
  charted-but-unbuilt answer (ticket 04 records the fallback).
- Bun 1.4's `Bun.serve` static `dir:` routes were considered for `/files` and REJECTED for
  now: the existing route's uniform-404 non-leaking semantics + realpath containment are
  audited, and Bun's built-in symlink-escape prevention is Linux-only.

## Cross-effort links

- **Shares-decision-with**: `.planning/2026-08-15-archify-webui-html` — that effort's
  decisions 01 (full-fidelity file route) and 03 (CSP posture) are the foundation this one
  builds the in-shell viewer on; they are extended, not superseded. Its ticket 05
  (fog: shell-hosted interactive result loop) is partially answered by D4 here.
- **Shares-decision-with**: `.planning/2026-08-18-webui-simplify` — pane consolidation
  precedent (`setPane` shape, `more` grouping); the Diagram pane follows it.
