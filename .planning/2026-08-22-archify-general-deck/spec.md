# Spec — archify: general deck generator (data-driven layout templates)

> STATUS: drafted 2026-08-22. Design approved by the user the same day (geometry vocabulary
> "A"; `image` deferred). Every runtime claim in §2 was **probed on this machine**
> (bun 1.4.0, pptxgenjs 4.0.1) — raw numbers in `map.md` § Context. Verified against
> `bun-apps/s2-agent-ext-archify/{lib,extensions,scripts,__tests__,examples,skills}` at
> commit `635f9cee5`.

## §1 Goal

Turn `s2-agent-ext-archify` from a tool that composes **architecture-review** decks into one
that composes **ordinary business** decks, and do it so the next arrangement after these
seven costs a file rather than a release.

1. **A layout can be added as data.** One `*.layout.json` on the search path becomes a usable
   `layout:` value — geometry, inputs and type scale in that one file, zero `.ts` edits.
2. **Seven templates ship**, covering what a general deck needs and the current six do not:
   `kpi-row`, `table`, `compare`, `timeline`, `agenda`, `quote`, `end`.
3. **The agent can see and self-check cheaply.** One new tool lists every available layout
   with its inputs, and lints a manifest **without rendering a single diagram**.
4. **Authoring gets an outline door.** A structured Markdown outline becomes a manifest, so
   the common deck is written as prose rather than as nested JSON.

**Non-goals** (explicit, YAGNI):

- `image` slides, and any change to the zero-blip assertion (D6).
- Fixing `.planning/2026-08-21-archify-deck-visual-fidelity`'s P1–P4 (D7).
- Editing `vendored/` — it is a pinned upstream snapshot.
- Charts/graphs as a drawing primitive; corporate-template import (`pptx-automizer`);
  animations, transitions; PDF or Keynote output; per-slide inline colour overrides.
- Outline round-tripping (manifest → Markdown).

## §2 Background (measured, not quoted)

### 2.1 The seam is already the right shape

`lib/layouts.ts` is six pure functions `Slide → PlacedBlock[]`. They name no colour, import
no emitter, and return boxes as **stage fractions** rather than inches. `lib/emit-pptx.ts`
and `lib/emit-html.ts` consume that array and key off `Role` and nothing else.

That means a template engine is a **seventh producer of `PlacedBlock[]`**, not a second
pipeline. Nothing downstream needs to know whether a layout came from a function or a file:

```
Slide ──resolveLayout──▶ registry ──┬─ code layout  (6, frozen)      ──┐
                                    └─ template     (*.layout.json)  ──┴──▶ PlacedBlock[]
                                                                           │
                                                             ┌─────────────┴─────────────┐
                                                      emit-pptx.ts                emit-html.ts
```

### 2.2 The three things that block "add a file = add a layout"

| # | blocker | file |
|---|---|---|
| 1 | `LAYOUTS` is a hardcoded `Record`; `SLIDE_LAYOUTS` a frozen six-element union | `layouts.ts:216`, `slide-model.ts:62` |
| 2 | `TYPE_SCALE` is a `Record<Role, TypeSpec>` the emitters index directly — a new role is a `.ts` edit in three files | `deck-theme.ts` |
| 3 | `parseManifest` validates `layout` against the static array, so it cannot report what IS available | `deck-build.ts:171` |

None is deep. (1) and (3) are one registry; (2) is a one-parameter change to both emitters.

### 2.3 `table` as a drawing primitive — probed

`pptxgenjs@4.0.1` exposes `addTable(rows, opts): Slide` (`types/index.d.ts:2664`) with
`TableRow = TableCell[]`, `TableCell = { text?, options? }` (:1767–1774).

A 3×3 CJK table was built and read back with the package's own `readZipText` + `lintPptx`:

```
bytes 59860  write 10.1 ms
<a:blip>            0        ← the acceptance property holds
<a:tbl> present     yes, inside 1 <p:graphicFrame>
lintPptx            clean    ← the existing OOXML gate already accepts graphicFrame
```

This is why `table` is in scope and `image` is not: one is provably vector under the existing
gates, the other provably is not.

### 2.4 What the agent pays today

Four registered tools. `lintDeck()` runs only inside `archify_export_pptx`
(`export-pptx.ts:126`), so the cheapest path to "is my writing any good?" is a full build:
every IR through `deliver`, every SVG through `parseSvg`, a `.pptx` written to disk. On
`examples/deck/` that is 0.26 s and five artifact renders to be told a title reads as a label.

Worse, there is **no catalog**. Which layouts exist is discoverable only by reading
`skills/archify/SKILL.md` — which is exactly the surface that must not grow once layouts
become files, because a template dropped in by a user will never be in a shipped skill file.

### 2.5 Why not an expression language

The obvious template spelling puts arithmetic in the file:

```json
{ "box": { "x": "0.037 + i*0.235", "y": 0.2, "w": 0.21, "h": 0.25 } }
```

Rejected (D1). It needs a parser and an evaluator in a package whose runtime dependency list
is two entries; JSON Schema can validate it no further than "is a string"; a typo produces a
runtime error at render time instead of a load-time diagnostic; and it pushes the hard part
(geometry) onto template authors, where it will be got wrong repeatedly, and away from the
resolver, where it is written once with goldens on it.

## §3 Decisions

**D1 — Declarative containers, zero expressions.**
A template composes four primitives: `region` (a named area), `stack` (weighted split into
rows/columns), `repeat` (iterate an array slot into equal cells), `box` (`"fill"` or
`{inset:[l,t,r,b]}` in inches). Bindings are single enumerated tokens — `{field}`,
`{slide.title}`, `{index1}` — never arithmetic. *Chosen by the user 2026-08-22.*

**D2 — A template file is self-contained.**
`name` + `description` + `chrome` + `slots` + `roles` + `body`, all in one file. `roles`
entries may set `sizePt` / `bold` / `tracking` / `lineSpacing` and a `color` that **must** be
an existing `Palette` key — checked at load. Without per-template roles the promise fails at
the first template needing a 40 pt number; with an unrestricted `color` the Cardinal Rule
fails instead.

**D3 — Code layouts outrank templates and cannot be shadowed.**
Name resolution: the six code layouts, then user templates, then shipped templates. A
template named `diagram` is a **load error**, not an override. Reason: `diagram`'s XML is
byte-locked against a pre-composition capture; a file on a search path must not be able to
break that. Accepted cost: changing `split`'s default geometry means taking a new name.

**D4 — Templates recombine primitives; they do not add drawing.**
Adding a `BlockContent.kind` is a `.ts` change in **both** emitters, deliberately. Recorded
in `CONTEXT.md` under *Drawing primitive* so the boundary reads as a design line rather than
as a limitation discovered later.

**D5 — `table` is the one primitive added this round.** See §2.3. Measured, not assumed.

**D6 — No `image`.** Supporting it forces the zero-blip assertion from "every slide, always"
to "diagram regions only", weakening the single property a regression back to screenshots
cannot fake. The user's direction for that future round is recorded and is *not* this design:
prefer shapes wherever a shape can express it (shapes stay editable); when an image is
genuinely needed, fetch it from the network, freeze it as a **compact local asset**, and keep
the bundle minimal.

**D7 — Build on the known-defective render path.**
`.planning/2026-08-21-archify-deck-visual-fidelity` has four confirmed rendered defects, five
open tickets, and no code landed. P1 (icons fill in as star bursts), P3 (SVG node text clips,
CJK breaks mid-word) and P4 (split diagram sits small and low) all live in
`lib/pptx-shapes.ts`, the diagram-replay path — untouched by this effort, which produces
prose and primitives through `emit-pptx.ts`'s text-box path. **P2 does overlap**: every
template sets `chrome: true` and inherits the fixed title band that was measured overflowing.
This effort neither fixes nor re-decides P2; §6 states the sequencing consequence.

**D8 — One new registered tool.**
`archify_deck_lint` is registered (4 → 5 tools). The Markdown outline is a new **input shape**
on `archify_export_pptx`, not a third tool, because the schema-cost canary charges every
registered tool in every session. Same reasoning that put `irPaths` and `manifestPath` on one
tool rather than two.

**D9 — Catalog lives in the tool, not in the skill.**
`archify_deck_lint` with no manifest returns every available layout with its `description`,
`slots` and source path. `SKILL.md` therefore documents *how to ask*, never the list itself —
which is the only arrangement that can describe a template a user dropped in last week.

## §4 Design

### 4.1 `templates/layout-template.schema.json` — the contract

```jsonc
{
  "name": "kpi-row",                    // ^[a-z][a-z0-9-]*$, must not equal a code layout
  "description": "2–4 metric tiles across the content well",   // the agent reads THIS
  "chrome": true,                       // true | false | { "title": false }
  "slots": {
    "kpis": { "kind": "array", "of": ["value", "label", "note?"],
              "min": 2, "max": 4, "required": true,
              "description": "one tile per entry" }
  },
  "roles": {
    "kpiValue": { "sizePt": 40, "bold": true, "color": "title" },
    "kpiLabel": { "sizePt": 12, "color": "muted" }
  },
  "body": [ /* Node[] */ ]
}
```

`SlotSpec.kind` ∈ `text | array`. `of` names the fields an array item may carry; a trailing
`?` marks optional. Validation of a *slide against its template's slots* happens in
`archify_deck_lint` and in `parseManifest`, so a missing required slot is a manifest error
with the template's own `description` attached, not a blank slide.

### 4.2 The four primitives

```jsonc
// root nodes bind to a named area
{ "region": "content",  /* + one of: stack | repeat | box */ }
{ "region": "full",     ... }

// weighted split; weights are relative, gap in inches
{ "stack": { "dir": "col", "weights": [0.5, 0.5], "gap": 0.4 },
  "children": [ Node, Node ] }

// iterate an array slot into equal cells; each cell re-runs `cell` with item scope
{ "repeat": { "over": "kpis", "flow": "row", "gap": 0.3, "max": 4 },
  "cell": [ Node, ... ] }

// terminal: put content in this area
{ "box": "fill" | { "inset": [0.2, 0.3, 0.2, 1.1] },
  "content": { "kind": "text", "role": "kpiValue", "from": "{value}" },
  "align": "center", "valign": "middle" }
```

**Regions.** Two, both takeaway-aware where it matters:

| region | inches | note |
|---|---|---|
| `content` | `x 0.5`, `y 1.4` (`1.5` with a takeaway), `w 12.333`, `h 7.0 − y − 0.5` | the bullets-style well; what `chrome: true` leaves free |
| `full` | `0, 0, 13.333, 7.5` | full bleed, for divider-like templates |

`CONTENT` (`0.5, 1.18, 12.333, 5.7`) is deliberately **not** exposed as a region: it is the
`diagram` layout's frozen geometry and belongs to the D3 lock.

**Bindings.** `{field}` (inside a `repeat` cell, from the item), `{slide.<key>}`,
`{index1}` / `{index0}`. Anything else in a `from` string is a load-time error. A literal
string with no braces is used verbatim.

### 4.3 `lib/layout-template.ts` — the resolver

One export, mirroring what `layoutFor` already returns:

```ts
export interface LoadedTemplate {
  name: string;
  description: string;
  slots: Record<string, SlotSpec>;
  roles: Record<string, TypeSpec>;
  source: string;                       // absolute path, for the catalog
  render(slide: Slide, ctx: LayoutCtx): PlacedBlock[];
}
export function loadTemplate(json: unknown, source: string): LoadedTemplate;  // throws TemplateError
```

`render` walks `body` depth-first carrying an `InchBox` scope, appends `chrome(slide, ctx)`
first when `chrome` is set, and emits through the same `at()/text()` constructors
`layouts.ts` uses — so a template's blocks are indistinguishable from a code layout's, and
`formatBlocks()` prints both the same way.

**All arithmetic is here**: `stack` divides by weights minus gaps, `repeat` divides by count
minus gaps. The template file contains no numbers that depend on a count.

### 4.4 `lib/layout-registry.ts` — resolution and precedence

```ts
export function loadRegistry(opts: { manifestDir?: string; env?: NodeJS.ProcessEnv }): LayoutRegistry;
export interface LayoutRegistry {
  has(name: string): boolean;
  render(name: string, slide: Slide, ctx: LayoutCtx): PlacedBlock[];
  roleOf(name: string): (role: string) => TypeSpec;   // { ...TYPE_SCALE, ...template.roles }
  catalog(): CatalogEntry[];                          // name, description, slots, source
  names(): string[];                                  // for error messages
}
```

Search order, first hit wins **within** the template tiers, code layouts winning outright:

1. the six code layouts (D3)
2. `$ARCHIFY_TEMPLATES` (`:`-separated dirs), then `<manifestDir>/templates/`
3. `<pkg>/templates/*.layout.json`

Errors are loud and load-time: a template named after a code layout, two templates with the
same name in the same tier, a `color` outside `Palette`, a `from` token that is not
enumerated, a `repeat.over` naming an undeclared slot, a `content.kind` no emitter knows.

### 4.5 Role resolution — the contained refactor

`TYPE_SCALE` stops being the emitters' index and becomes the builtin base. `EmitPptxCtx` and
the HTML emitter's context each gain `roleOf: (role: string) => TypeSpec`. `Role` widens to
`string` **at the emitter boundary only**; `layouts.ts` keeps the narrow union internally, so
the six code layouts lose no type safety. `AUTOFIT_ROLES` gains a per-role `autofit?: boolean`
in `TypeSpec` so a template can opt its long-running text into `fit: "shrink"`.

### 4.6 `lib/emit-pptx.ts` / `lib/emit-html.ts` — the `table` primitive

New content kind, added to both:

```ts
| { kind: "table"; columns: string[]; rows: string[][]; role: Role; headerRole: Role }
```

pptx → `slide.addTable(rows, { ...box, colW, fontFace, fontSize, border, fill,
autoPage: false })`. `autoPage: false` is set **explicitly and asserted**: `autoPage` splits a
long table onto generated slides, which would insert slides the manifest never declared and
break the 1:1 slide-index ↔ manifest-entry assumption in `emit-html.ts` and in the page-number
chrome. HTML → a `<table>` inside the positioned div, styled from the same two roles.

### 4.7 The seven shipped templates

| name | slots | geometry |
|---|---|---|
| `kpi-row` | `kpis[]{value,label,note?}` (2–4) | `repeat` row over `content` |
| `table` | `columns[]`, `rows[][]`, `note?` | one `box` with `kind:"table"` |
| `compare` | `left{heading,bullets}`, `right{…}` | `stack` col 50/50, heading + bullets per side |
| `timeline` | `milestones[]{date,label,note?}` (3–6) | rule spanning `content`, `repeat` row of stations |
| `agenda` | `items[]{title,note?}` (3–8) | `repeat` col, `{index1}` numbering |
| `quote` | `quote`, `attribution`, `role?` | centred `box` + rule + attribution |
| `end` | `headline`, `contact?` | `full` panel + centred type |

`quote` vs the existing `statement`: `statement` is the presenter's own claim, `quote` is
somebody else's words with attribution. Distinct enough to be two templates, and the pair is
what stops authors from abusing `statement` for citations.

### 4.8 `archify_deck_lint` — the cheap door

```
{ manifest?: string | object, baseDir?: string }
```

- **No `manifest`** → `catalog()`: every layout, its `description`, its `slots`, its source.
  This is the discovery surface (D9).
- **With `manifest`** → parse → validate every slide against its layout's slots →
  `lintDeck()` → `storyline()`. **No `deliver`, no `parseSvg`, no `.pptx`.** The only file
  access is reading the manifest (and, for `ir` slides, an existence check).
- Inline `object` + `baseDir` lets the agent lint a draft it has not written to disk.

### 4.9 `lib/outline.ts` — Markdown outline → manifest

YAML frontmatter carries deck-level fields. Then:

| marker | becomes |
|---|---|
| `# H1` | `title` slide; a following `> quote` line is its `subtitle` |
| `## NN Text` | `section` slide (`sectionNumber` = `NN`) |
| `### Text` | a content slide; its action title |
| `^ text` | `takeaway` |
| `~ text` | `source` |
| `- item` / `  - item` | `bullets`, level 0 / 1 |
| `!ir <path>` | `ir`; with bullets ⇒ `split`, without ⇒ `diagram` |
| ` ```:::<name>` … JSON … ` ``` ` | `layout: <name>` + the JSON merged as its slots |

The sugar covers the six code layouts — the common case. **Every template-driven slide goes
through the fenced JSON payload**, so the dialect stays small and does not need to grow a
syntax per template. Wired as `outline` / `outlinePath` on `archify_export_pptx` and as
`--outline` on `bun run deck` (D8).

### 4.10 Skill surface

```
skills/archify/SKILL.md               diagram-first; deck shrinks to 3 lines + a pointer
skills/archify/deck.md                deck writing rules, outline dialect, "ask the catalog first"
skills/archify/authoring-templates.md NEW — how to write a *.layout.json
```

`SKILL.md` must not list the layouts (D9). It says: call `archify_deck_lint` with no
arguments.

## §5 Testing

Renderer-free throughout, per `ADR`-less standing posture inherited from
`archify-deck-visual-fidelity` D1 ("the renderer sees, it never gates").

| test | asserts |
|---|---|
| `__tests__/layout-template.test.ts` | schema accept/reject pairs; each primitive's geometry against a `formatBlocks` golden; every load-time error class fires |
| `__tests__/layout-registry.test.ts` | precedence order; a template named `diagram` is rejected; duplicate names in one tier are rejected; `roleOf` merge; `catalog()` shape |
| `__tests__/bullets-equivalence.test.ts` | **the bar**: a template reconstruction of `bullets` produces `formatBlocks` output line-for-line identical to the code layout, with and without a takeaway |
| `__tests__/fixtures/templates/<name>.txt` | one golden per shipped template |
| `__tests__/deck-lint-tool.test.ts` | catalog with no manifest; slot validation; **no `deliver` spawn** (spy on `runArchify`) |
| `__tests__/outline.test.ts` | each marker; fenced payload merge; malformed fence is an error |
| `__tests__/emit-pptx.test.ts` (extended) | `table` → `<a:tbl>`, `<a:blip>` = 0, `autoPage` false |
| `__tests__/deck-composition.test.ts` (extended) | `examples/deck-general/` builds; blip 0 per slide; `lintPptx` clean |

**Untouched, and must stay green unmodified**: the D3 byte-identity lock, all five existing
`<a:blip>` assertions, `no-browser-deps.test.ts`, `theme-drift.test.ts`,
`validators-drift.test.ts`.

## §6 Gate

Ship when, from `bun-apps/s2-agent-ext-archify`:

1. `bun test` green with **no edits to the D3 lock or any existing blip assertion**.
2. `bun run typecheck` clean.
3. `bun run deck examples/deck/deck.config.json` still reports **5 slides, 388 native
   shapes** — the legacy deck is the compatibility canary.
4. `bun run deck examples/deck-general/deck.config.json --lint` → content lint clean, ooxml
   lint clean, blip 0 on every slide.
5. A template dropped into `$ARCHIFY_TEMPLATES` at runtime appears in
   `archify_deck_lint`'s catalog and renders — **verified from a directory outside the
   repo**, because "add a file" is the whole claim and an in-repo test cannot prove it.
6. `bun run --cwd bun-apps/s2-agent regen:manifest` re-run and the schema-cost canary
   re-measured after registering the fifth tool.

### Sequencing note (not a gate)

`.planning/2026-08-21-archify-deck-visual-fidelity` Phase 1 fixes the chrome that all seven
templates sit under (P2). Landing it **first** costs nothing here and avoids re-baselining
seven geometry goldens after the title band changes height. Landing it after means doing that
re-baseline. Neither ordering is wrong; only one is cheaper.
