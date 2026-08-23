# s2-agent-ext-archify

The ubiquitous language of s2-agent-ext-archify — the package that turns typed JSON into
technical diagrams and, from those plus prose, into a meeting deck of **native, editable
PowerPoint shapes**. Nothing here rasterizes, and nothing here downloads a browser: those
two absences are the design, not an omission, and most of the vocabulary below exists to
keep them true.

## Language

### The authored input

**IR** (intermediate representation):
The typed JSON a diagram is authored as — `schema_version` + `diagram_type` + `meta` +
the type's own arrays. The IR is the source; every rendered form is derived from it.
_Avoid_: config, spec, model (it is a validated typed document with a schema, not settings)

**Diagram type**:
One of the five renderer modes — `architecture`, `workflow`, `sequence`, `dataflow`,
`lifecycle`. Each has its own schema and its own vocabulary; `diagram_type` in the IR
selects it and there is no cross-type slide.
_Avoid_: kind, mode, chart type (it is the schema selector, named `diagram_type` in the file)

**Cardinal Rule**:
Semantic role in, theme colour out. An IR sets `type` / `variant` on a component and the
renderer maps that to a palette entry; **an inline `#rrggbb` anywhere is a defect**. The
rule extends to slides: a layout names a `Role`, `deck-theme.ts` names the colour, and
`deck-lint.ts` flags a literal hex in copy.
_Avoid_: styling convention, colour policy (it is a hard rule with a lint behind it)

**Artifact**:
The self-contained `.html` a rendered IR becomes — one file, no external fetches,
interactive, and (for a `diagram` slide) literally the slide itself.
_Avoid_: output, render, export (the `.pptx` is also output; "artifact" is the HTML one)

**`deliver`**:
The vendored CLI path that validates → renders → checks → commits atomically. Deck builds
call `deliver`, never bare `render`, so a deck can never be assembled from an artifact
archify itself considers broken.
_Avoid_: render, build (bare `render` skips the validation and check halves)

### The neutral seams

**ShapeIR**:
A format-neutral, paint-ordered shape list with transforms applied and styles resolved —
what an artifact's `<svg>` becomes on the way to PowerPoint. It is the seam any future
exporter (PDF, Keynote, Figma) attaches to.
_Avoid_: shape list, display list (it is a named seam with golden fixtures pinning it)

**`PlacedBlock`**:
One item on a slide: a box plus what goes in it (`text` / `bullets` / `diagram` / `rule` /
`panel`). It says WHERE and WHAT, never how wide the text will be.
_Avoid_: element, node, widget (it is a placed box with typed content, not a component)

**`FracBox`**:
A box in stage-relative fractions, every value in `[0, 1]`. Fractions, not inches, so a
layout can be read and diffed without knowing the stage size — and so a fractions-vs-inches
mix-up shows up as an out-of-range box instead of a shape quietly parked off-slide.
_Avoid_: rect, bounds (the unit is the point of the name)

**Box-not-metrics**:
The rule that makes the zero-browser contract survivable: *a block declares a box; the
target environment wraps text inside it*. PowerPoint wraps in a text box, CSS wraps in a
positioned div, and neither needs a glyph advance from us. This is also why the composed
path gets CJK right where the diagram path cannot.
_Avoid_: layout engine, text fitting (there is no engine here; that is the whole point)

**Title band**:
The fixed box the action title occupies on a content slide (`TITLE_BAND` in `deck-theme.ts`;
9.0 in wide, two heights depending on whether a takeaway shares the band). It is the one
box on a slide that cannot absorb an overflow: it does not autofit, and the accent rule sits
below it at a fixed `y`, so a second line comes out struck through and clipped.
_Avoid_: header, title area (the point of the name is that it is a fixed band, not a region
that grows)

**Wrap budget**:
The em width one line of the title band holds — box width minus OOXML's two default insets,
divided by the type size. A title over budget is a **build error**, not a style note,
because the result is a visibly broken deliverable rather than an unidiomatic one.
_Avoid_: title length limit, max characters (a character count cannot predict a wrap; that
miscalibration is exactly the defect this replaced)

**Em advance**:
The estimated set width of a character, in ems, bucketed into four classes — full width,
space, narrow, wide — in `text-extent.ts`. Bucketed and not a per-glyph table on purpose: a
metrics table would be tied to one font and would rot the first time a deck sets a different
`defaults.font`. The buckets are calibrated against rendered ink and hold to ±2 %.
_Avoid_: font metrics, glyph width (this estimates a class, it does not measure a glyph)

**Role**:
The semantic slot a piece of type occupies (`title`, `takeaway`, `bullet`, `statement`,
`pageNumber`, …). Both emitters key off `Role` and nothing else, which is what stops them
from drifting; `TYPE_SCALE` maps a Role to size/weight/colour.
_Avoid_: style, class, variant (it is a semantic slot, and the only key an emitter may read)

**Emitter**:
A consumer of `PlacedBlock[]` — `emit-pptx.ts` (native shapes + real text boxes) and
`emit-html.ts` (a composed page). Two emitters, one authored model; a change that touches
only one of them is a drift bug.
_Avoid_: renderer, exporter (the vendored CLI is the renderer; these consume its output)

### The deck

**Deck manifest**:
`deck.config.json` — `output` / `theme` / `tag` / `defaults` / `slides[]`. `ir` and `output`
resolve relative to the manifest dir, so a manifest is portable.
_Avoid_: config, deck file (it is the authored slide list, and it is portable by design)

**Action title**:
A slide's `title` written as the takeaway in a complete claim ("Cold-path latency is what
users feel"), never a topic label ("Latency"). Stacked action titles are what let a deck be
read from the titles alone.
_Avoid_: headline, slide title (a topic label is also a "slide title"; this is the opposite)

**Storyline**:
The action titles in order. Read top to bottom it IS the deck's argument — if it does not
hold together there it will not hold together in the room. `bun run deck --lint` prints it.
_Avoid_: outline, agenda (an outline lists topics; a storyline states claims)

**Takeaway** / **Source**:
The "so what" band under the title, and the attribution footnote. An exhibit missing both is
hard to defend in the room, which is why `deck-lint` says so (advisorily).
_Avoid_: caption, note (they are two distinct, separately-linted fields)

**Layout**:
Which arrangement a slide uses. Six are shipped as code — `title`, `section`, `bullets`,
`split`, `diagram`, `statement` — each a pure `Slide → PlacedBlock[]` function.
_Avoid_: template, slide type (a *template* is the data-driven kind, defined below)

**Layout inference**:
`ir` present and no `layout` ⇒ the slide IS a `diagram` slide. The shape of the old slide
already says what it is, which is the entire backward-compatibility story — no version field.
_Avoid_: default layout, fallback (it is inference from the authored shape, not a default)

### Extensibility

**Layout template**:
A `*.layout.json` file that defines a NEW layout as data — slots, roles and geometry — and
is registered by being on the search path. Adding one adds a layout with zero `.ts` change.
Distinct from the six code layouts, which templates may not shadow.
_Avoid_: layout, custom layout, theme (the six shipped ones are code; a template is a file)

**Slot**:
A named hole a template declares and a slide fills (`kpis[]`, `columns`, `left.bullets`).
Slots are what `archify_deck_lint` reports back so the agent knows what a template wants.
_Avoid_: field, prop, variable (it is a declared, validated input of one template)

**Region / stack / repeat / box**:
The four primitives a template composes with — a root node binds a named area (`content`,
`full`), then exactly one of a weighted split into rows/columns, an iteration over an array
slot into equal cells, or a box that draws a content block in a cell. **Arithmetic lives in the
resolver, never in the template file**; there are no expression strings, so a template stays
JSON-Schema-validatable.
_Avoid_: grid, flex, container (borrowed CSS names imply behaviour these do not have)

**Drawing primitive**:
A `BlockContent.kind` — what an emitter knows how to draw (`text`, `bullets`, `diagram`,
`rule`, `panel`, `table`). Templates recombine primitives; **adding a primitive is a `.ts`
change in both emitters.** Templates solve arrangement, not new ways to draw.
_Avoid_: content type, block type (the name has to carry "the emitters must both learn it")

**Deck skeleton**:
A ready-to-fill deck under `templates/decks/*.outline.md`, authored in the outline dialect and
reported beside the layouts by `archify_deck_lint` (its `description` is the first `#` H1 after
frontmatter). It is a finished shape, not a piece — an agent that asks "what can I make?" gets
both the layouts and some complete decks to imitate.
_Avoid_: template, example (a *skeleton* ships as an outline; an *example deck* ships as a
manifest + IRs)

**Outline dialect**:
The Markdown markers that turn an outline into a deck manifest (`#`/`## NN`/`###`, `^`, `~`,
`-`, `!ir`, and a fenced `:::<name>` JSON payload for a layout template). The fenced payload is
the only route to a template; its explicit layout always wins over the `!ir`
split-vs-diagram inference. Sugar covers the six code layouts only.
_Avoid_: outline, markdown deck (the dialect is the marker set, not a file format)

### The guarantees

**Zero-blip**:
The acceptance property: every slide's XML contains `<a:blip>` **zero times**. A blip is an
image reference, so zero of them is the one thing a regression back to screenshots cannot
fake. Asserted in five test files.
_Avoid_: no images, vector-only (those are descriptions; zero-blip is the assertion)

**D3 lock**:
The byte-identity guarantee on `diagram` slides — their XML must match a pre-composition
capture exactly, so every manifest written before layouts existed builds unchanged. It is
why the `diagram` layout's coordinates and block ORDER are frozen, and why code layouts
outrank templates in the registry.
_Avoid_: backward compat, regression test (it is byte identity, strictly stronger than both)

**Zero-browser**:
Neither this package nor its webui sibling downloads a browser. `no-browser-deps.test.ts`
bans only packages that BUNDLE a download (`playwright`, `puppeteer`); `playwright-core`,
`puppeteer-core` and `Bun.WebView` are allowed, because they drive an already-installed
engine.
_Avoid_: headless-free, no-Playwright (the ban is on bundled downloads, not on engines)

**OOXML lint**:
The structural check on a built `.pptx` — content types cover every part, every `r:id`
resolves, EMU coordinates are integers in range, `spPr` / `custGeom` children follow their
schema sequences, every `a:path` opens with `a:moveTo`. It is a permanent gate; a full
ECMA-376 XSD run is deliberately a one-off receipt instead.
_Avoid_: validator, schema check (it is a hand-built structural gate, not an XSD run)

**Renderer-free assertion**:
A check computed from the emitted OOXML or the slide model with no rendering engine
involved, so it runs identically everywhere. Standing posture: **the renderer sees, it never
gates** — this repo has already been burned by a renderer-gated check that skip-gated itself
into irrelevance for months.
_Avoid_: visual test, snapshot (a snapshot needs a renderer, which is the thing being ruled out)

**Receipt**:
A dated, committed write-up under `receipts/` of a one-off measurement too expensive or too
platform-bound to be a gate (an ECMA-376 XSD run, a `qlmanage` render sweep).
_Avoid_: report, benchmark (a receipt records something that will NOT be re-run in CI)

### The surface

**Vendored snapshot**:
`vendored/` — archify@2.12.0 (MIT) pinned as a local copy: the CLI binary, schemas, the
five renderers, and 13 example IRs. After the vendor-copy there is **no dependency on the
upstream source**, and skills must cite `vendored/` paths, never upstream ones.
_Avoid_: dependency, submodule (it is a frozen copy this package owns outright)

**Webui announce**:
The string-literal event channel — `webui:open` after a render/delta, `webui:deck` after a
build, `webui:present` for approve/regenerate. archify imports nothing from webui; the
literal channel name is the whole contract, and with no webui present every emit is a no-op.
_Avoid_: integration, hook (there is no import edge; "integration" overstates the coupling)

**Schema-cost canary**:
The per-tool token budget measured from the registry manifest. Every registered tool costs
tokens in every session, which is why a new capability reaches for a new INPUT SHAPE on an
existing tool before it reaches for a new tool.
_Avoid_: token budget, overhead (it is a specific measured gate, `schema-cost.ts`)
