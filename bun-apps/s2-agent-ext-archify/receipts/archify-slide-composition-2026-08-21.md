# Receipt — slide composition: compatibility + OOXML validity

- **Date:** 2026-08-21
- **Machine:** darwin arm64, bun 1.4.0, pptxgenjs 4.0.1, libxml2 `xmllint` (system)
- **Effort:** `.planning/2026-08-21-archify-slide-composition/`
- **Scope:** everything below was run on this machine against the code at the effort's
  final commit. Nothing here is quoted from documentation.

## 1. D3 compatibility — byte-identical, not merely equivalent

`examples/deck/deck.config.json` predates layouts (its slides carry only `ir` / `title` /
`subtitle`). The five slide XML parts were captured BEFORE the refactor, then the deck was
rebuilt through the new `SlideModel → layouts → emit-pptx` path and compared:

```
slide1  BYTE-IDENTICAL
slide2  BYTE-IDENTICAL
slide3  BYTE-IDENTICAL
slide4  BYTE-IDENTICAL
slide5  BYTE-IDENTICAL
```

The first comparison was NOT identical: it differed by exactly `algn="l"` on the chrome
paragraphs, in 4 places per slide. `algn="l"` is the OOXML default (the pre-composition
builder omitted `align` entirely), so it changed nothing visually — but it proved the
comparison was worth doing at the byte level rather than at the level of counts.
`emit-pptx.ts` now omits `align` when it is `left`, and `__tests__/deck-composition.test.ts`
pins the per-slide `algn="l"` counts (5, 7, 7, 5, 7 — all from DIAGRAM labels, where
`pptx-shapes.ts` sets the anchor explicitly) so chrome cannot start contributing any.

Shape/text counts moved from `23/21, 43/26, 59/20, 62/49, 34/21` to
`25/25, 45/30, 61/24, 64/53, 36/25`. That is **not** a geometry change: the old counter
returned only what `addShapeIrToSlide` placed, so the chrome's 2 shapes + 4 text runs per
slide were never counted. Same slide, honest total.

## 2. OOXML structural lint (`lib/ooxml-lint.ts`) — the permanent gate

Both example decks, all seven rules: **0 diagnostics**. 36 parts (legacy) / 40 parts
(composed), linted in ~17 ms.

Two false positives were found and fixed while calibrating it, both worth recording because
each is a trap a future rule can fall into again:

1. **ZIP directory entries are not parts.** A real `.pptx` carries 19 of them; they are
   absent from `[Content_Types].xml` by design. `readZipText` now skips them.
2. **`<a:ext>` is two different elements.** `CT_PositiveSize2D` (cx/cy) lives under
   `<a:xfrm>`; `CT_OfficeArtExtension` (uri) lives under `<a:extLst>`. Checking for cx/cy
   without looking at the parent reports every theme part as broken.

## 3. ECMA-376 XSD validation — the one-off (effort decision D5)

Not a permanent gate: it needs ~86 XSD files and a system `xmllint`. Run once, here.

Schemas from `t-yuki/ooxml-xsd` (86 files). libxml2 cannot assemble them as published —
each part imports the DrawingML namespace separately and libxml2 skips every import after
the first, so `pml-slide.xsd` alone yields hundreds of *schema-assembly* errors that look
like document errors and are not. The fix is two generated wrappers: `ns-dml.xsd` includes
the 28 files whose `targetNamespace` is DrawingML-main, `ns-pml.xsd` imports that once and
then includes the 10 PresentationML files. **Grouping by declared `targetNamespace` is
essential** — `dml-chart.xsd`, `dml-diagram*.xsd` and friends are different namespaces and
including them breaks compilation.

Result across BOTH decks — all slides, slide masters, slide layouts, notes slides, notes
masters, presProps, viewProps, tableStyles and themes:

```
ECMA-376 XSD: 36 parts valid, 2 invalid
```

### The one real deviation, and why it is not being fixed

Both `ppt/presentation.xml` parts fail, identically:

```
element notesMasterIdLst: This element is not expected.
Expected is one of ( …sldSz, …notesSz ).
```

CT_Presentation's sequence is `sldMasterIdLst?, notesMasterIdLst?, handoutMasterIdLst?,
sldIdLst?, sldSz?, notesSz, …`. pptxgenjs emits `sldMasterIdLst, sldIdLst,
notesMasterIdLst, sldSz` — `notesMasterIdLst` two positions late.

This is **upstream, pre-existing and deliberate**. `pptxgenjs@4.0.1`'s own source carries the
comment `sldIdLst> causes warning in modern powerpoint!` at exactly that point: they moved
the element to placate PowerPoint, at the cost of the published sequence. It is not
introduced by this effort — the pre-refactor build has the same byte.

Not fixed, for three reasons: it is upstream's decision; correcting it would mean unzipping,
rewriting and rezipping a package we currently hand straight to `Bun.write`; and every
consumer tested accepts it. **It is deliberately NOT an `ooxml-lint` rule** — a gate that
fires on every build we produce is noise, and would train people to ignore the linter.

## 4. Independent consumers

- **macOS Quick Look** (`qlmanage -t`, Apple's own OOXML importer, not our code) renders
  `examples/deck-composed/composed.pptx` correctly, including the CJK cover type, the accent
  rule and the eyebrow tracking. A fourth parser, agreeing.
- **`Bun.WebView`** was used to screenshot the composed slide HTML. This is where the
  `?embed=1` finding came from: without it a `split` slide showed the archify artifact's
  entire page UI — its own dark toolbar and its own title — inside a 60 % column, repeating
  the title already above it. `?embed=1&theme=…` is the artifact's own documented contract
  (`vendored/assets/template.html` reads both), so the fix is a URL, not a hack. Also
  confirmed live: a `file://` iframe of a sibling file renders under WebKit.

## 5. Suite

```
bun run typecheck   clean
bun test            401 pass / 21 skip / 0 fail   (was 268 / 21 / 0)
```

## 6. Not attempted

- `[Content_Types].xml` and `.rels` parts were not XSD-validated: the OPC schemas are not in
  the schema set used here. `ooxml-lint` rules 1 and 2 cover exactly those two files'
  invariants, which is why they are rules rather than an afterthought.
- Rendering in Microsoft PowerPoint itself. Not installed on this machine.
