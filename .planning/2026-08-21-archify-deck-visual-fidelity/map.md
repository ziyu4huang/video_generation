---
effort: 2026-08-21-archify-deck-visual-fidelity
created: 2026-08-21
last: 2026-08-22
status: specified
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
- `tickets/01-icon-fill-semantics.md` — task, open — `<a:noFill/>` + `<a:path fill="none">`
- `tickets/02-title-overflow.md` — task, open — wrap budget vs chrome height
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

## Frontier

`tickets/01-icon-fill-semantics.md` — P1 is the most visible defect, the diagnosis is the
furthest along, and it carries the one open dependency question (whether `pptxgenjs@4.0.1`
can express `<a:noFill/>` and a per-path `fill` attribute at all, or whether the emitter has
to post-process the XML).

## Fog of war

- **Whether `pptxgenjs` can express the fix.** `lib/pptx-shapes.ts:85` already returns
  `{ fill: { type: "none" } }`, yet the emitted `<p:spPr>` contains **no fill element at
  all** — not `<a:noFill/>`. Either the option name is wrong or the library drops it.
  `pptxgenjs` is not installed in this worktree (isolated linker + globalStore), so this was
  **not** verified. Ticket 01 resolves it first, because the answer decides whether the fix is
  a one-line call change or an XML post-process.
- **`<a:path fill="…">` reachability.** Independently of `<a:noFill/>`, DrawingML defaults
  `<a:path>` to `fill="norm"`, so a stroke-only subpath is filled even on a no-fill shape.
  Whether pptxgenjs exposes that attribute is unknown.
- **LibreOffice fidelity and cost** are entirely unmeasured — not installed here. It is
  possible its OOXML fidelity differs enough from Apple's that the two backends disagree on
  what a slide looks like. That would not break D1 (nothing gates on either) but it would
  make cross-platform receipts non-comparable.
- **Whether P2's right fix is a stricter lint, a taller chrome, or title autofit** is open.
  The prior effort deliberately chose "no autofit on the title"; this effort has evidence
  that the chosen alternative failed, but that is an argument to strengthen the guard, not
  automatically to reverse the decision.
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
  effort blocks the other in code, but **landing this effort's Phase 1 first is cheaper**:
  P2's fix changes the chrome geometry all seven templates sit under, so doing it afterwards
  means re-baselining seven geometry goldens.
