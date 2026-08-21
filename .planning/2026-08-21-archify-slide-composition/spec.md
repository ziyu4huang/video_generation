# Spec — archify: slide composition (diagram tool → presentation generator)

> STATUS: drafted 2026-08-21. Design approved by the user the same day ("ok do it").
> Every runtime claim in §2 was **probed on this machine** (bun 1.4.0, pptxgenjs 4.0.1) —
> raw numbers in `map.md` § Context. Verified against
> `bun-apps/s2-agent-ext-archify/{lib,scripts,__tests__,examples}` at commit `b99e4ec4b`.

## §1 Goal

Turn `s2-agent-ext-archify` from a **diagram** generator into a **presentation** generator,
without losing anything it does today.

1. A deck manifest can compose slides from **six layouts** — `title`, `section`, `bullets`,
   `split`, `diagram`, `statement` — instead of only "one archify diagram per page".
2. Text on a composed slide is a **real PowerPoint text box** that wraps and autofits, not
   SVG coordinate text. This is what makes CJK decks usable.
3. The **same slide model** emits both `.pptx` and `.html`. One authored source, two surfaces.
4. The `.pptx` gains a permanent **OOXML structural validity** gate.

**Non-goals** (explicit, YAGNI): editing `vendored/` (it is a pinned upstream snapshot);
`kpi` / `timeline` / `matrix` / `comparison` layouts (second round); `pptx-automizer` /
corporate-template import; animations and slide transitions; PDF or Keynote output;
per-slide inline colour overrides.

## §2 Background (measured, not quoted)

### 2.1 What exists today

`lib/deck-build.ts` (420 lines) already produces a `.pptx` of **native editable shapes** —
no browser, nothing rasterized. Measured on `examples/deck/` (2026-08-21, this machine):
**5 slides, 302 KB, 358 native shapes, 0.29 s**, `<a:blip>` count 0 on every slide.
Baseline suite: **268 pass / 21 skip / 0 fail**.

The pipeline is:

```
IR .json --deliver--> .html --parseSvg--> SvgDoc --toShapeIR--> ShapeIR --> pptxgenjs
         (validated)        (HTMLRewriter)       (+ svg-theme)
```

`addShapeIrToSlide(slide, ir, box, opts)` already takes an arbitrary target `Box` in inches
and scales uniformly with centering. **Confining a diagram to a 60 %-wide column therefore
needs no change to the ShapeIR path at all** — only a different `box`.

### 2.2 The actual gap

A slide is hard-coded as *one diagram filling `CONTENT = {x:0.5, y:1.18, w:12.333, h:5.7}`*,
with fixed chrome drawn by a private `addChrome()`. There is no cover page, no bullet page,
no statement page. All text inside the diagram is SVG coordinate text mapped to text boxes
with `wrap: false` and an **estimated** width
(`node.fontSize * 0.62 * text.length * 1.35`, `lib/pptx-shapes.ts`) — a Latin-tuned advance
guess that is wrong for CJK, and by design cannot reflow.

### 2.3 Text metrics — the constraint that shapes the design

This package has a hard zero-browser-dependency contract
(`__tests__/no-browser-deps.test.ts`). Without a layout engine there are **no glyph metrics**,
so we cannot measure text. The design's answer is to never need to:

> **A block declares a box. The target environment wraps text inside it.**

PowerPoint wraps and autofits inside a text box (`fit: 'shrink'`, verified present in
`pptxgenjs@4.0.1` `types/index.d.ts:1816`); CSS wraps inside a positioned div. Neither needs
us to know how wide a glyph is. The existing SVG-text path keeps its estimate — it is
reproducing a fixed diagram layout, which is a genuinely different problem.

### 2.4 XML validity — measured today

`probe.pptx` (the example deck) unzipped to 36 parts; `xmllint --noout` over all of them:
**0 errors, everything well-formed**. `<a:custGeom>` children are emitted in the
CT_CustomGeometry2D order `avLst → gdLst → ahLst → cxnLst → rect → pathLst`. But
**no test asserts any of this** — the only structural assertion in the suite is
`<a:blip>` count 0.

### 2.5 `Bun.XML` A/B — re-run, and the earlier note was too coarse

`lib/svg-model.ts` currently states that `Bun.XML.parse` "collapses children into a
tag-name-keyed map, so document order across differing sibling tags is lost". Re-probed on
bun 1.4.0 against `ppt/slides/slide2.xml` (49 389 bytes):

| | `Bun.XML.parse` | `HTMLRewriter` |
|---|---|---|
| 50-run mean | **0.229 ms** | 0.335 ms |
| order across *distinct* sibling tags | **preserved** (object key insertion order) | preserved |
| order across *repeated* sibling tags | **lost, irrecoverably** | preserved |

The decisive probe — a real `<a:path>` segment list:

```
in   moveTo, lnTo, quadBezTo, lnTo
out  { "a:moveTo": {...}, "a:lnTo": [{...},{...}], "a:quadBezTo": {...} }
```

The 4th segment merges into the array holding the 2nd, and `quadBezTo` — document position
3 — lands after both. Four `preserveOrder`-style option spellings were probed: all are
**silently accepted and have no effect**.

So the correct statement is narrower than the one in the file: order survives when siblings
have distinct tag names, and dies when they repeat. That distinction decides where each
parser belongs (§4.6), and `lib/svg-model.ts`'s comment must be corrected to match.

## §3 Decisions

- **D1 — `SlideModel` + two thin emitters.** A layout is a pure function
  `Slide → PlacedBlock[]`, where a block carries a **stage-relative box** (fractions 0–1),
  its content, and a semantic role. `emit-pptx.ts` and `emit-html.ts` are the only modules
  that know an output format. Rejected: extending `vendored/` (forfeits upstream re-sync,
  and `vendored/VERSION` forbids it); HTML-first with a headless engine measuring geometry
  (violates the zero-browser contract).
- **D2 — boxes, never glyph metrics.** §2.3. This is the property that makes the design
  browser-free *and* CJK-correct, and it is why layouts return fractions rather than text
  extents.
- **D3 — backward compatibility by inference, not by a version field.** A slide with `ir`
  and no `layout` **is** `layout: "diagram"`, and that layout reproduces today's chrome
  geometry exactly. `examples/deck/deck.config.json` must build unchanged, to the same shape
  and text counts. A test pins those counts.
- **D4 — HTML fidelity is preserved per layout, not uniformly.** A `diagram` slide's
  `slide-N.html` stays **the archify artifact itself** — byte-for-byte today's behaviour, so
  the webui Diagram pane and its "full-fidelity and interactive" property are untouched.
  Composed layouts get our own HTML, and a `split`'s diagram is embedded as an `<iframe>`
  pointing at the archify artifact written beside it, so it stays interactive too.
- **D5 — OOXML validity is gated at the structural level, not the schema level.** A full
  ECMA-376 XSD validation would mean vendoring several MB of XSDs and depending on a system
  `xmllint`. Ship `lib/ooxml-lint.ts` (§4.6) as the permanent gate; run the XSD pass once and
  keep it as a receipt.
- **D6 — parser split follows the measurement.** `ooxml-lint` uses `Bun.XML` for its
  order-insensitive checks and for `spPr` child order (whose children are all distinct tags,
  so key order *is* document order); it uses `HTMLRewriter` for the `a:path` segment check,
  which is exactly the case `Bun.XML` destroys. `lib/svg-model.ts` keeps `HTMLRewriter` and
  its comment is corrected per §2.5.
- **D7 — consulting slide conventions are schema, not prose.** Action titles, the "so what"
  band and the source footnote are first-class fields; the horizontal-logic check is a
  storyline dump. `lib/deck-lint.ts` is **advisory** — it warns, it never blocks a build.

## §4 Design

### 4.1 `lib/slide-model.ts` — the seam

```ts
/** Stage-relative box; every value is a fraction of the stage (0..1). */
interface FracBox { x: number; y: number; w: number; h: number }

type Role =
  | "coverTitle" | "coverSubtitle" | "eyebrow" | "date"
  | "sectionTitle" | "title" | "takeaway" | "body" | "statement"
  | "source" | "pageNumber" | "tag";

type BlockContent =
  | { kind: "text";    role: Role; text: string }
  | { kind: "bullets"; role: Role; items: BulletItem[] }
  | { kind: "diagram"; ir: string }        // absolute path to an archify IR
  | { kind: "rule" }                       // accent bar
  | { kind: "panel"; tone: "tag" | "section" };

interface PlacedBlock {
  box: FracBox;
  content: BlockContent;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
}
```

`Slide` is the authored shape (`layout`, `title`, `subtitle`, `takeaway`, `source`,
`bullets`, `ir`, `statement`, `eyebrow`, `date`, `ratio`, `notes`). Only `title` is
required; `parseManifest` keeps validating it.

### 4.2 `lib/layouts/*.ts` — six pure functions

`(slide: Slide, ctx: LayoutCtx) => PlacedBlock[]`, `ctx = { index, total, tag }`. No module
here imports pptxgenjs, HTML, or a colour.

| layout | composition |
|---|---|
| `title` | eyebrow · big cover title · subtitle · accent rule · date |
| `section` | full-bleed tone panel · section number · large section title |
| `bullets` | chrome + one full-width bullet column (levels 0–1) |
| `split` | chrome + diagram at `ratio` (default **0.6**) left, bullets right |
| `diagram` | chrome + full-width diagram — **today's geometry, exactly** |
| `statement` | chrome + one large centred statement + attribution |

Shared `chrome(slide, ctx)` emits tag panel, tag text, title, takeaway (when present),
accent rule, source/subtitle footer, page number — the same five elements `addChrome()`
draws today, at the same coordinates, expressed as fractions of the 13.333 × 7.5 stage.

### 4.3 `lib/deck-theme.ts` — tokens

`PALETTES` moves out of `deck-build.ts` unchanged (six existing keys keep their names and
values so the `diagram` layout is pixel-identical), extended with `body`, `muted`,
`statement`, `panelBg`, `panelBorder`, `sectionBg`, `sectionFg`. A `TYPE_SCALE: Record<Role,
{ sizePt, bold?, tracking? }>` lives here too, so "how big is a title" has one home.
`deck-build.ts` re-exports `PALETTES` so existing importers do not break.

### 4.4 `lib/emit-pptx.ts`

`PlacedBlock[] → SlideLike`. `text` → `addText(text, { wrap: true, fit: 'shrink', … })`;
`bullets` → one `addText(TextProps[])` with `bullet` + `indentLevel` + `breakLine`
(all three verified in `pptxgenjs@4.0.1` types); `diagram` → `parseSvg` + `toShapeIR` +
`addShapeIrToSlide` with the block's box converted to inches — the existing path, unchanged.

### 4.5 `lib/emit-html.ts`

`PlacedBlock[] → string`. A `.stage` with `aspect-ratio: 16/9` and `position: relative`;
each block an absolutely positioned div at its box in `%`; `diagram` → an `<iframe>` at the
sibling artifact. Self-contained: one inline `<style>`, no external asset. Per D4 this is
used only for composed layouts.

### 4.6 `lib/ooxml-lint.ts` — the validity gate

`lintPptx(parts: Record<string,string>) => OoxmlDiagnostic[]`, fed by the existing
`readZipText` helper (promoted from `__tests__/helpers/` to `lib/` so both lint and tests
use one reader).

1. `[Content_Types].xml` covers every part (Default by extension, or Override by PartName).
2. Every `r:id` / `r:embed` resolves in the sibling `_rels/<part>.rels`.
3. `a:off/@x,@y` and `a:ext/@cx,@cy` are integers; `cx,cy ≥ 0`; all within ±27 273 042 316 900 EMU.
4. `p:spPr` children follow the CT_ShapeProperties sequence.
5. `a:custGeom` children follow the CT_CustomGeometry2D sequence.
6. `a:rPr/@sz`, `a:defRPr/@sz` ∈ [100, 400000] (ST_TextFontSize).
7. Every `a:path` begins with `a:moveTo`. **`HTMLRewriter` only** — §2.5.

### 4.7 `lib/deck-lint.ts` — advisory

`storyline(manifest)` prints the titles in order (the horizontal-logic read). `lintDeck`
warns on: a title that reads as a label rather than a claim, a title over 90 chars, more
than 6 bullets, nesting deeper than level 1, and any `#rrggbb` in authored text (archify's
Cardinal Rule). Surfaced by `bun run deck --lint` and in the tool result `details`.
Never blocks.

### 4.8 What `deck-build.ts` becomes

An orchestrator: resolve manifest → per slide, `layout()` → `emit-pptx` + `emit-html` →
write → announce. `addChrome`, `PALETTES`, `STAGE`/`CONTENT` and the inline diagram call
all move out. This is not opportunistic refactoring: the module currently owns manifest
parsing, theming, chrome geometry, rendering, event announcement and thumbnails at once,
and every one of the six layouts would otherwise be added inside it.

## §5 Testing

- **Layout goldens** — each layout's `PlacedBlock[]` serialized one line per block, in the
  `formatShapeIR` style (a diff reads as "this box moved").
- **Compat lock (D3)** — rebuild `examples/deck/` and assert per-slide shape/text counts
  match today's measured `23/21, 43/26, 59/20, 62/49, 34/21`, and that the manifest needs
  no edit.
- **Cross-emitter consistency** — for one slide of every layout, the set of text strings in
  the HTML equals the set in the PPTX. Catches a block dropped by one emitter only.
- **`<a:blip>` = 0** — the existing acceptance property, kept.
- **`ooxml-lint` over a built deck** — zero diagnostics; plus unit tests feeding it
  deliberately broken XML for each of the seven rules.
- **`Bun.XML` order receipt** — a test that pins the §2.5 finding, so a future bun release
  that fixes it is noticed rather than assumed.

## §6 Gate

```
( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun run test )
```
