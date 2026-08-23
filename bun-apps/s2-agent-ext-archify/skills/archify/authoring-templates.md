# Authoring an archify layout template

A `*.layout.json` adds a **new slide layout as data** — slots, roles and geometry — with three
lines of contact to the build path: it is registered by being on the search path. Adding one
adds a layout with **zero `.ts` change**, which is the whole claim. This doc is all a fresh
reader needs to write a working template; the authoritative resolver is
`src/layout-template.ts`, but everything it enforces is spelled out here.

## The contract

```jsonc
{
  "name": "kpi-row",                    // ^[a-z][a-z0-9-]*$, must NOT equal a code layout
  "description": "2–4 metric tiles in one row across the content well…",   // the agent reads THIS
  "chrome": true,                       // true | false | { "title": false }
  "slots": { "kpis": { … } },           // named holes a slide fills
  "roles": { "kpiValue": { … } },       // role overrides merged over the builtin type scale
  "body": [ … ]                         // Node[]
}
```

- **`name`** — the value a manifest slide uses for `layout`. Lowercase, hyphenated. Must not
  name one of the six code layouts (`title`, `section`, `bullets`, `split`, `diagram`,
  `statement`) — shadowing those is a load error (see precedence).
- **`description`** — shown in the `archify_deck_lint` catalog. This is what an agent reads to
  decide "is this the layout I want", so write it as *when to use it* and *what it draws*,
  not a one-word label.
- **`chrome`** — wear the shared frame (tag chip, action title, accent rule, footer, page
  number)? `true` (default) / `false` / `{ "title": false }` to drop just the title band.
- **`slots`** — the named holes the slide must fill; validated at lint and parse time.
- **`roles`** — size/weight/colour overrides merged over the builtin type scale.
- **`body`** — the geometry, composed of the four primitives below.

## The four primitives

Everything in a `body` is built from exactly four primitives. **All arithmetic lives in the
resolver, never in the template file** — there are no expression strings, so a template stays
JSON-Schema-validatable (effort decision D1).

### `region` — bind a node to a named area

A root `body` node names the region it draws in; nested scopes inherit it. Two regions:

- **`content`** — the takeaway-aware well (y ≈ 1.4, or 1.5 when a takeaway shares the band).
  This is where a content slide's body lives.
- **`full`** — the whole stage, for chrome-free layouts.

```jsonc
{ "region": "content", "repeat": { "over": "kpis", "flow": "row", "gap": 0.3, "max": 4 }, "cell": [ … ] }
```

> `content` is deliberately NOT a region you can shadow — see the D3 lock.

### `stack` — divide an area into weighted rows or columns

```jsonc
{ "stack": { "dir": "row", "weights": [11, 1], "gap": 0.15 }, "children": [ … ] }
```

`dir: "row"` stacks rows on top of each other (each child a band of the height); `dir: "col"`
lays columns side by side. `weights` are the width/height shares (not fractions — any positive
numbers, they are normalised). `gap` is inches between cells. From the shipped `table` template:
the body splits `11:1` to leave room for the footnote column.

### `repeat` — iterate an array slot into equal cells

```jsonc
{ "repeat": { "over": "kpis", "flow": "col", "gap": 0.5, "max": 2 }, "cell": [ … ] }
```

`over` names an **array slot** declared in `slots`. `flow` is `row`/`col`. `max` caps the count
(beyond it, extra items are dropped). From the shipped `compare` template: two equal columns,
one per `sides[]` entry.

### `box` — draw a content block inside a cell

```jsonc
{ "box": "fill",
  "content": { "kind": "text", "role": "kpiValue", "from": "{value}" },
  "align": "center", "valign": "bottom" }
```

`box` is `"fill"` (the whole cell) or `{ "inset": [left, top, right, bottom] }` in inches.
`content` declares what is drawn (the **drawing primitive** below); `align`/`valign` place it.

## Slots

A slot is a named hole the slide fills. Two kinds:

- **`text`** — one scalar value (`{"kind": "text", "required": true}`).
- **`array`** — a list; declare the fields each item may carry in `of`, with a trailing `?` for
  optional, plus `min`/`max`/`required`.

```jsonc
"kpis": { "kind": "array", "of": ["value", "label", "note?"], "min": 2, "max": 4,
          "required": true, "description": "one tile per entry" }
```

The **binding tokens** a template may use are enumerated, never computed: `{field}` (an array
item's field), `{slide.<key>}` (a manifest slide field, e.g. `{slide.title}`), `{index0}` /
`{index1}` (0- and 1-based position in a repeat). No arithmetic — `"{i + 1}"` is an error.

## The drawing primitives (what a `box` can draw)

A `content.kind` is a **drawing primitive** — what an emitter knows how to draw: `text`,
`bullets`, `diagram`, `rule`, `panel`, `table`. Templates **recombine** these; a new
**arrangement** (`kpi-row`, `compare`, …) is just a file that stacks/repeats/boxes them. But a
new **drawing primitive** is a `.ts` change in **both** emitters (`emit-pptx.ts` and
`emit-html.ts`) — by design (effort decision D4). A template is the cheap kind; never reach for
a new drawing primitive when a new arrangement would do.

`text` / `bullets` / `diagram` need `role` + `from` (or `ir`). `rule` draws a rule. `panel`
fills a plate (`tone: "tag" | "section"`). `table` is the one special case: it needs a `role`
(body), `headerRole` (the column-head row), and two bindings — `columns` (column names) and
`rows` (row arrays) — e.g. `{ "columns": "{slide.columns}", "rows": "{slide.rows}" }`. A table
is **never split across slides** (the emitter pins `autoPage: false`), so keep to ~12 body rows.

## The `Palette`-key restriction on `roles.color`

`roles` merge over the builtin type scale. A role may set `sizePt`, `bold`, `tracking`,
`lineSpacing`, `autofit`, and `color` — but `color` **must be an existing Palette key**, never
a literal colour:

```jsonc
"kpiValue": { "sizePt": 40, "bold": true, "color": "title" }
```

The allowed keys are the Palette enum — `slideBg`, `title`, `accent`, `subtitle`, `tagBg`,
`tagBorder`, `body`, `muted`, `statement`, `panelBg`, `panelBorder`, `sectionBg`, `sectionFg`.
**Why:** the Cardinal Rule — a semantic role in, theme colour out — extends to layouts. The
original six Palette keys are **frozen** (they are what the `diagram` layout paints with and
that layout is byte-identical to the pre-composition builder, the D3 lock), and `deck-theme.ts`
is the single home for "what colour". A template that wrote a hex would both break the
light/dark theme switch and quietly fork the colour palette.

## Search path and precedence

A layout name resolves first-hit-wins, in this order:

1. **The six code layouts** win outright. A template named after one is a **load error**, not
   an override — `diagram`'s XML is byte-locked against a pre-composition capture, and a file
   on a search path must not be able to reach that (effort decision D3).
2. **`$ARCHIFY_TEMPLATES`** — `:`-separated directories — then **`<manifestDir>/templates/`**.
3. **The packaged tier** — `<pkg>/templates/*.layout.json` (what ships with the package).

Two failure modes are load errors by design:

- A template **shadowing a code layout name** (`name: "diagram"`) — the D3 lock.
- **Duplicate names within one search tier** — silent shadowing within a tier is how a user's
  edit stops taking effect for no visible reason. Across tiers the earlier one silently wins.

The same three-tier discipline governs **deck skeletons** under `templates/decks/` (ready-to-fill
outlines reported by `archify_deck_lint`): `<root>/templates/decks/` first, then the packaged
tier. Note the skeletons do **not** read `$ARCHIFY_TEMPLATES` — only the layout templates do.

## Load-time errors (self-diagnosing)

Every failure is raised at load time, naming the **source file, the JSON path, and what was
expected** — render time is too late to learn about a typo. The common ones:

- `.roles` must be an object keyed by role name; a role not in the builtin scale must carry
  `sizePt` and `color`.
- `.slots` must be an object keyed by slot name; `slot.kind` is `"text"` or `"array"`; `of`
  belongs to array slots only; `min`/`max` are positive integers.
- A `from` binding must be `{token}`-enumerated (`malformed binding braces`).
- `kind` needs its fields: `text`/`bullets` need `role` + `from`; `diagram` needs `from` (IR
  path); `table` needs `role` + `headerRole` + `columns`/`rows`; `tone` is `"tag"`/`"section"`.
- `box` is `"fill"` or `{ "inset": [l, t, r, b] }` (four finite numbers, inches).
- A root node must bind a `region` (`content` or `full`); nested scopes come from
  `stack`/`repeat`/`box`.
- Exactly one primitive per node (`stack` / `repeat` / `box` at the top of `body`).
- `stack` needs `dir` ∈ {row, col}, ≥2 positive `weights`, a non-negative `gap`.
- `repeat` needs a declared array-slot name for `over`, a `flow`, a non-negative `gap`, and a
  non-empty `cell`; `max` is a positive integer.
- `.name` must match `^[a-z][a-z0-9-]*$` and not equal a code layout; `.description` is a
  non-empty string (it is what the catalog shows the agent); `.chrome` is `true`, `false`, or
  `{ "title": false }`; `.body` is a non-empty array.

## The title-band suppression trap

If your template sets `chrome: false` or `chrome: { "title": false }` (like the shipped `end`
and `quote`), it drops the title band — the quote/headline *is* the slide. But the deck content
lint still measures the slide's `title` field against the band width. So on such a layout, keep
any `title` within the band budget, or it will refuse to build even though the band is never
drawn. Prefer your own slots (`quote`, `headline`) as the content and leave `title` short.
