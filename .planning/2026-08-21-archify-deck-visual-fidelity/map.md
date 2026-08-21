---
effort: 2026-08-21-archify-deck-visual-fidelity
created: 2026-08-21
last: 2026-08-22
status: in-progress
---
# archify-deck-visual-fidelity — what the deck actually looks like

## Destination

The four defects a rendered `.pptx` shows and no existing gate can see are fixed, each
behind a **renderer-free** structural assertion that runs on any platform. Rendering
itself becomes an on-demand tool behind a portable `pptx → N images` seam, plus a one-off
receipt — never a CI gate.

## Context (measured 2026-08-21 on this machine, after #1769 landed)

### The enabling fact

`qlmanage -t -s 1600 -o <dir> <file>.pptx` renders a deck through **macOS's own OOXML
importer** — zero install, `/usr/bin/qlmanage`, already present. Measured: **0.13 s** for
one file. Quick Look returns only the *first* slide, so the six-slide composed example was
split into six one-slide decks and rendered in **0.24 s total**. Fidelity is high: CJK
correct, type scale correct, the theme rule and eyebrow correct.

`soffice` is **not installed here**, so the LibreOffice path is charted but **unmeasured** —
no number is claimed for it anywhere in this effort.

### What the render found — four defects, none visible to any existing gate

The suite is 401 passing, `ooxml-lint` reports 0 diagnostics on both example decks, and
`deck-lint` passes. All four survived that.

> **CORRECTED 2026-08-22 (ticket 01).** P1's attribution below is **wrong**, and the
> correction is worth more than the original entry. The bursts are not a fill-semantics
> problem at all: they are `<a:prstGeom prst="roundRect">` shapes carrying
> `<a:gd name="adj" fmla="val 269169"/>`, where ECMA-376 caps that adjustment at **50000**.
> Past the cap the preset's corner arcs self-intersect — that IS the burst. 43 out-of-range
> values across the two example decks, worst 317450. Root cause is a unit error at the
> library boundary: `rectRadius` is a LENGTH IN INCHES (`adj = rectRadius * 914400 * 100000 /
> min(cx, cy)`), while pptxgenjs's typings say "values: 0.0 to 1.0" and archify passed a
> fraction. Both fill fixes below were implemented and **each re-rendered pixel-identical**;
> only the adjustment fix removed the bursts. The fill work is kept as a latent-correctness
> fix, not as the P1 cure.
>
> Method note: the original entry reasoned from the XML to a cause and stopped. What found
> the real cause was re-rendering after **each** fix and refusing to accept an unchanged
> image as success.

- **P1 — stroke-only icons fill in and render as star bursts.** Every node icon and all five
  legend swatches. Attribution **confirmed against the HTML twin**: in
  `composed.slides/slide-4.html` the legend swatches are rounded-rect outlines and the node
  icons are small rounded-square glyphs; in the `.pptx` they are radiating asterisks.
  The geometry is **not** the problem — shape 36 is lucide `code` (two chevrons) and shape 48
  is `database` (a cylinder), both emitted with correct coordinates. The problem is fill
  semantics, see §2.1 of `spec.md`.
- **P2 — the action title overflows its fixed chrome and is struck through by the rule.**
  Composed slide 4's title wraps to two lines; the second line is crossed by the theme rule
  and clipped. `deck-lint`'s title-length rule passed it. `map.md` of
  `archify-slide-composition` predicted this exact failure ("a title that silently shrinks is
  worse than one a linter complains about") and chose the linter — the linter did not hold.
  **FIXED 2026-08-22 (ticket 02).** The decision held; the calibration did not. A
  90-character count cannot see a box width, a type size, or the difference between `一` and
  `i`. Measured on this machine: the title band holds **24.37 em** (9.0 in less OOXML's two
  default insets, at 26 pt), the clipped title measured **27.66 em**, and the em dash it
  carried is a **full em**, not a Latin character. Seven of the eight real content-slide
  titles across both example decks already fit — so the band was the right size and the
  title was too long. `lib/text-extent.ts` now predicts the wrap renderer-free (buckets
  calibrated against rendered ink, ±1.7 %) and `buildDeck` refuses a deck that trips it.
  Receipt: `receipts/archify-title-wrap-calibration-2026-08-22.md`.
- **P3 — SVG node text clips and wraps wrongly.** `SYS.1/2 需求來源` renders clipped;
  the connector label `系統需求` breaks as `系統需 / 求`. This is the known `wrap: false` +
  `fontSize * 0.62 * length * 1.35` Latin advance estimate in `lib/pptx-shapes.ts`, now with
  a picture attached.
- **P4 — a `split` slide's diagram sits small and low in its column.** Large dead space above
  it. **Attribution not established** — it may be correct uniform-scale-and-centre applied to
  an artifact bounding box that itself includes the legend row and empty canvas. Ticket 04
  establishes attribution before proposing a fix.

### The portability constraint

`qlmanage` is darwin-only. `no-browser-deps.test.ts` bans only packages that **bundle a
browser download**; `Bun.WebView`, `playwright-core` and system binaries are all permitted,
so portability is a design choice here, not a contract violation.

The decisive prior: that same file records that CI skip-gates "made the old mermaid
paint-check dead for months". A gate that needs a renderer degrades to a dead gate the
moment it runs anywhere without one. Hence D1 below.

## Tickets

Phase 1 — the defects, each with a renderer-free assertion
- `tickets/01-icon-fill-semantics.md` — task, **closed 2026-08-22** — the burst was an
  out-of-range `roundRect` adjustment, NOT fill semantics; see its `## Resolution`
- `tickets/02-title-overflow.md` — task, **closed 2026-08-22** — wrap budget in ems, at
  error severity; the chrome geometry is unchanged. See its `## Resolution`
- `tickets/03-node-text-advance.md` — task, open — CJK-aware advance, or a real text box
- `tickets/04-split-diagram-fit.md` — task, open — establish attribution, then fit

Phase 2 — seeing it, portably
- `tickets/05-portable-render-seam.md` — task, open — `pptx → N images`, 3 backends, receipt

## Decisions

- **D1 — the renderer sees, it never gates.** Every permanent assertion in this effort is
  computed from the emitted OOXML or the slide model, with no rendering engine involved, so
  it runs identically on darwin, Linux and Windows. Rendering is an on-demand command plus a
  one-off committed receipt. Reason: this repo has already been burned by a renderer-gated
  check that skipped itself into irrelevance for months.
- **D2 — the seam is `pptx → N images`, not `render one slide`.** The two backends reach N
  images by genuinely different routes — Quick Look yields only slide 1 so it needs the deck
  split into N one-slide decks first, while LibreOffice converts the whole deck to a PDF and
  rasterizes pages. Putting the interface below that difference would leak it to callers.
- **D3 — no golden-pixel baselines in git.** Committed PNGs would be renderer-version and
  font dependent, unreviewable in a diff, and would churn on every legitimate change.
  Charted-but-rejected, not merely unbuilt.
- **D4 — fix before instrument.** P1–P4 are known and real now; building the harness first
  would defer four confirmed defects behind infrastructure. Chosen by the user 2026-08-21.
- **D5 — a lint note may block a build, but only one may.** `deck-lint` was documented as
  advisory-forever, on the sound reasoning that a style rule which refuses to build teaches
  people to disable the linter. That reasoning is kept for every style rule; a title wider
  than its band is exempt because the output is *visibly broken*, not merely unidiomatic.
  The split is expressed as a severity (`error` vs `warn`/`info`), so the exemption is one
  field rather than a special case, and `buildDeck` is the single enforcement point.

## Frontier

`tickets/03-node-text-advance.md` — P3. With P1 and P2 closed it is the last defect whose
*attribution is already established*: `lib/pptx-shapes.ts` places diagram labels with
`wrap: false` and a `fontSize * 0.62 * length * 1.35` Latin advance estimate, and applies it
to CJK. P4 still needs an attribution step before it can be worked, so P3 goes first.

P3 is also cheaper now than when it was written, because ticket 02 built the thing it needs:
`lib/text-extent.ts` already answers "how wide does this string set" with CJK-aware buckets
measured on this machine, and P3's estimate is the same question with a worse answer.
Whether P3's remedy is to route through `textEms()` or to give node labels a real wrapping
text box is still open — the second is a larger change to the D3-locked diagram path.

Tickets 01 and 02 both closed 2026-08-22, and both root causes turned out to differ from
what `spec.md` predicted in the same way: a number crossing a library or format boundary in
the wrong unit.

## Fog of war

- ~~**Whether `pptxgenjs` can express the fix.**~~ **RESOLVED 2026-08-22** — `<a:noFill/>`
  yes (omit `fill`); `<a:path fill="none">` no (hardcoded template literal). Full probe table
  in ticket 01's `## Resolution`.
- ~~**Whether the fill-semantics fix matters at all.**~~ **RESOLVED 2026-08-22 — removed.**
  The path-level half (`write-zip.ts` + `ooxml-postprocess.ts`) was built, measured
  pixel-identical, and deleted. The decisive argument is structural, not renderer-dependent:
  a `ShapeIR` node carries ONE style and emits ONE `<a:path>`, so a per-subpath fill differing
  from the shape's fill is unreachable from archify's model. The `<a:noFill/>` call-site fix
  stays. Full reasoning + the "how to post-process OOXML if you ever must" receipt are in
  ticket 01's `## Resolution`.
- **Other preset adjustments.** `shape-adjust-range` uses `0..50000`, which is right for every
  preset archify currently emits (`roundRect` only). ECMA-376 gives each preset its own range,
  and a future preset with a wider legal range would false-positive. Cheap to fix when it
  happens; wrong to generalise speculatively now.
- **P4 may not be `split`-specific.** The legacy deck's slide 3 — a full-width `diagram`
  layout, not `split` — also renders its diagram low with a large empty band above. Ticket 04
  should widen its attribution step to both layouts before proposing a fix.
- **LibreOffice fidelity and cost** are entirely unmeasured — not installed here. It is
  possible its OOXML fidelity differs enough from Apple's that the two backends disagree on
  what a slide looks like. That would not break D1 (nothing gates on either) but it would
  make cross-platform receipts non-comparable.
- ~~**Whether P2's right fix is a stricter lint, a taller chrome, or title autofit.**~~
  **RESOLVED 2026-08-22 — a stricter lint.** The measurement decided it: seven of eight real
  content-slide titles fit the existing band, so the band was not too small and neither a
  taller chrome nor autofit was warranted. Full reasoning in ticket 02's `## Resolution`.
- **The advance buckets are calibrated on ONE font.** `EM_ADVANCE` was measured against
  PingFang TC bold at 26 pt, which is what both example decks set. A deck choosing a wider
  face via `defaults.font` would set wider than the model predicts and could wrap while
  passing the check. Bounded risk — it is 4 buckets, not a metrics table — and the
  calibration table frozen in `__tests__/text-extent.test.ts` is what any re-tune would have
  to beat.
- **Quick Look ignores `rIns` when breaking lines.** Measured: it breaks against the full box
  width, PowerPoint against the box less both insets. The shipped budget follows PowerPoint,
  so the check is deliberately stricter than the renderer used to calibrate it. Consequence
  worth remembering: a render on this machine can NOT disprove a marginal `title-overflows`
  note — it will show one line where PowerPoint shows two.
- **Bun.WebView on Linux/Windows** (WebKitGTK / WebView2) is unprobed. Only relevant if the
  HTML twin ever becomes part of the receipt.

## Cross-effort links

- **Builds-on**: `.planning/2026-08-21-archify-slide-composition` — this effort's P2 is the
  live failure of that effort's title-guard decision, and its P1/P3 sit in the
  `ShapeIR → pptxgenjs` path that effort inherited unchanged from
  `archify-view-pptx-bun`. That effort's fog entry "text overflow … no metric for it without
  a layout engine" is **partly answered**: a renderer cannot gate, but it can *find*, which
  is how P1–P4 were found at all.
- **Shares-decision-with**: `.planning/2026-08-21-archify-view-pptx-bun` — its zero-browser
  posture is respected here; D1 narrows it from "no engine" to "no engine in a gate".

- **Shares-decision-with**: `.planning/2026-08-22-archify-general-deck` — that effort adds
  seven layout templates, **all of which set `chrome: true`** and therefore inherit P2's
  unfixed fixed-height title band. Its D7 declines to absorb P1–P4 (they live in
  `pptx-shapes.ts`, the diagram-replay path; its own work is in `emit-pptx.ts`'s text-box
  path), and its D1 "the renderer sees, it never gates" is carried over verbatim. Neither
  effort blocks the other in code, but **landing this effort's Phase 1 first is cheaper**.
  **Updated 2026-08-22**: the re-baselining worry is gone — P2's fix left `TITLE_BAND`
  numerically unchanged and merely moved it from an inline literal in `layouts.ts` into
  `deck-theme.ts`, so templates read the same geometry from a shared constant. What the seven
  templates DO inherit is the new build gate: a template sample deck carrying an over-budget
  title will refuse to build, so `06-template-library` should run its titles through
  `textEms()` while authoring rather than discover it at build time.
