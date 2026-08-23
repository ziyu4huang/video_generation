# Archify decks

Compose IRs *and prose* into a meeting deck — a 16:9 `.pptx` of native, editable PowerPoint
shapes plus browsable slide HTML. Companion to `SKILL.md` (diagram authoring); read that first,
then this for anything deck-shaped.

## The door: ask, then build

Two tools only — one to discover, one to build:

1. **`archify_deck_lint`** — with **no arguments** it lists everything available: every layout
   (the six code layouts first, then every `*.layout.json` template from the search path) with
   its `description`, `slots`, and `source` path, plus every ready-to-fill **deck skeleton**
   and the copy-adapt **IR library** (`examples/ir-library/`): per IR its `diagram_type`,
   `title`, `description`, suggested `pairing`, and path.
   This is the discovery surface: **ask it before guessing a layout name.** The set is data —
   someone may have dropped a template on the search path yesterday — so a hardcoded list is
   wrong the moment it happens, and *being wrong there is worse than being absent*.
   - The IR library is the "copy-adapt" path: 12 validated generic archetype IRs (5 diagram
     types × 2–3) + 3 harvest-tier real chip IRs, each already through `deliver`, plus the
     flagship deck `examples/ir-library/decks/library.config.json` showing them woven with
     the 7 rich templates. When a slide needs a diagram, pick a cataloged IR and adapt it —
     do not author from schema memory.
   - With a `manifest` (path, or the object itself for an unwritten draft) it validates each
     slide's fields against its layout's slots, stats every `ir`, runs the content lint, and
     returns the **storyline** — all with **zero rendering**. Run it before ever building.
2. **`archify_export_pptx`** — build the deck (`manifestPath`/`irPaths` + optional
   `outputPath`/`theme`/`slidesDir`). Equivalently `bun run deck <manifest> [--lint]`.

The manifest (`deck.config.json`) is: `output`, `theme`, `tag`, `defaults`, `slides[]`. `ir`
and `output` resolve relative to the manifest dir, so a manifest is portable.

## The writing rules (these are a deck's quality)

1. **`title` is an ACTION TITLE** — the takeaway as a complete claim ("Cold-path latency is
   what users feel"), never a topic label ("Latency"). Read in order, the titles must BE the
   argument; that is what a reviewer checks first. `bun run deck --lint` prints the storyline.
   An action title that reads as a topic label is a `title-is-a-label` note.
2. **One idea per slide.** More than 6 bullets, or nesting past level 1, means two slides
   (`too-many-bullets` / `bullets-too-deep`).
3. **`takeaway` is the "so what"**, `source` is the attribution. An exhibit without either is
   hard to defend in the room (`missing-source`).
4. **Never write a colour into copy.** Same Cardinal Rule as the IR — semantic role in, theme
   colour out (`inline-color`).
5. `split` defaults to 60/40, not 50/50. Leave `ratio` alone unless the diagram demands it.

Most of these are **advisory notes** — they print a note and never change the exit code. One
rule is **not**:

> **A title wider than its band is a build error.** The title band is the one box on a slide
> that cannot absorb an overflow: it does not autofit, and the accent rule sits below it at a
> fixed `y`, so a second line comes out struck through and clipped. `buildDeck` refuses to write
> a deck that trips it. If `archify_deck_lint` reports `title-overflows`, shorten the title (or,
> on a chrome-free layout, use the template's own slots — see below).

## The one-folder rule

Keep every artifact of one deck inside a single named project folder: the `deck.config.json`,
the IR `.json` files, the exported `.pptx`, its `*.slides/` HTML, and every rendered diagram
HTML. Put `deck.config.json` in the project folder and leave manifest-relative paths alone —
do **not** pass an absolute `outputPath` pointing outside it. `archify_export_pptx` attaches an
advisory when the output leaves the manifest folder; treat that as a defect to fix.

## The Markdown outline dialect

For a deck that is mostly prose with a few templates on it, author it as an outline instead of
manifest JSON — `archify_export_pptx` takes `outline`/`outlinePath`, and `bun run deck
<file>.md --outline` reads it. YAML frontmatter carries the deck-level fields; the body uses
markers:

| marker | becomes |
|---|---|
| `# H1` | `title` slide; a following `> line` is its `subtitle` |
| `## NN Text` | `section` slide, `sectionNumber` = `NN` |
| `### Text` | content slide; `Text` is its action title |
| `^ text` | `takeaway` |
| `~ text` | `source` |
| `- item` / `  - item` | `bullets` level 0 / 1 |
| `!ir <path>` | `ir`; with bullets ⇒ `split`, without ⇒ `diagram` |
| ` ` `:::<name>` + JSON | fenced payload → `layout: <name>`, JSON merged as its slots |

**The fenced payload is the ONLY route to a layout template** — there is no marker per
template, ever, because the dialect would have to grow one every time someone drops a file on
the search path. An unknown layout name fails with the registry's "here is what IS available"
message, not a JSON error.

**Precedence:** a fenced payload's explicit `layout` always wins — the `!ir` split-vs-diagram
inference applies only when a slide carries no layout. An `ir` on a template slide that never
binds it (`quote`, `bullets`, …) is simply unused. Every outline failure names its line number.

> The outline dialect covers the **six code layouts** as sugar. A layout **template** always
> goes through the fenced payload — do not invent a marker for one.

## The template layouts

The six code layouts are built in and cannot be shadowed. More layouts arrive as **data** —
`*.layout.json` files on the search path — so the full available set is whatever
`archify_deck_lint` (no args) says it is. **Never hardcode the list.** How to author one:
`authoring-templates.md`.

Two built-in layouts and two shipped templates **suppress the chapter chrome**:

- `statement` (code) draws the *statement* in place of the title band.
- `quote` / `end` templates set `chrome: false` / `chrome: { title: false }`, so the title
  band, page number, and (on `quote`) takeaway band are absent by design — the quote/headline
  IS the slide. If you set a `title` on these, keep it short: the content lint still measures
  `title` against the band width, so an over-budget title on a slide that never draws the band
  will refuse to build.

## Sample decks (imitate these)

- `bun run deck examples/deck-composed/deck.config.json --lint` — the canonical
  showcase: one slide per code layout, IR + prose composed, zero lint notes.
- `bun run deck examples/deck-general/deck.config.json --lint` — the library
  proof deck: every shipped `*.layout.json` template next to the code layouts,
  content- and ooxml-lint clean.
- `bun run deck examples/deck/deck.config.json` — the legacy baseline (5 slides,
  388 native shapes); it rebuilds unchanged and is the compatibility canary.
- The four skeletons under `templates/decks/*.outline.md` (listed by `archify_deck_lint`) are
  ready-to-fill outlines in this dialect — `technical-review`, `project-kickoff`,
  `incident-review`, `product-proposal`.

## On-demand depth

Layout craft / design system / self-review / delivery gate → `vendored/SKILL.md` (§ Layout
principles, § Architecture Mode).
