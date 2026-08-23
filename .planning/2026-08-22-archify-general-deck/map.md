---
effort: 2026-08-22-archify-general-deck
created: 2026-08-22
last: 2026-08-23
status: active
---
# archify-general-deck — architecture-diagram tool → general slide generator

## Destination

A new slide layout can be added to `bun-apps/s2-agent-ext-archify` by **dropping one
`*.layout.json` file on the search path** — no `.ts` change, no rebuild, no registration.
Seven such templates ship (`kpi-row`, `table`, `compare`, `timeline`, `agenda`, `quote`,
`end`), so the package composes an ordinary business deck and not only an architecture
review. The agent discovers what is available, and self-checks what it wrote, through one
cheap tool that renders nothing.

Today's behaviour is preserved exactly: the six code layouts stay code, the D3 byte-identity
lock on `diagram` slides stays byte-identical, and zero-blip stays zero.

## Context (measured 2026-08-22 on this machine, bun 1.4.0 / pptxgenjs 4.0.1)

### Baseline

- **Green: 405 pass / 21 skip / 0 fail, 11.65 s** (`bun test`, 38 files, 4700 assertions).
  A first run reported 17 failures — **entirely an uninstalled worktree** (`Cannot find
  package 'typebox' / 'pptxgenjs' / 'marked'`). `bun install` from `bun-apps/` (9 packages,
  148 ms) cleared all 17. No baseline defect; the earlier count is not a finding.
- `bun run deck examples/deck/deck.config.json` → 5 slides, **302 KB, 388 native shapes,
  0.26 s**. Per slide (shapes/texts): 25/25, 45/30, 61/24, 64/53, 36/25.
- `bun run deck examples/deck-composed/deck.config.json --lint` → 6 slides, **167 KB,
  150 native shapes, 0.14 s**; content lint **clean**; ooxml lint **clean (40 parts)**.
- Source: 26 modules / 5389 lines in `lib/`. The four biggest are `shape-ir.ts` 703,
  `deck-build.ts` 469, `svg-theme.ts` 399, `ooxml-lint.ts` 385.

### The `table` primitive is reachable — probed, not assumed

`pptxgenjs@4.0.1` exposes `addTable(tableRows: TableRow[], options?: TableProps): Slide`
(`types/index.d.ts:2664`); `TableRow = TableCell[]`, `TableCell = { text, options }`
(:1767–1774), and `TableProps` carries `colW` / `border` / `fill` / `autoPage`.

A 3×3 CJK table was **built and read back** (scratch probe, 2026-08-22):

| measured | value |
|---|---|
| `<a:blip>` in `slide1.xml` | **0** |
| `<a:tbl>` present | yes, inside 1 `<p:graphicFrame>` |
| `lintPptx` diagnostics | **clean** |
| size / write time | 59 860 B / 10.1 ms |

So a native table is genuinely vector, and the existing OOXML gate already accepts the
`graphicFrame` part structure with no change. This retires the single largest unknown in the
design: it was the one place a new drawing primitive could have collided with the zero-blip
acceptance property.

### What the existing seam already gives us

- `layouts.ts` is already six **pure** `Slide → PlacedBlock[]` functions that name no colour
  and import no emitter. A template resolver is a seventh producer of the same type, not a
  parallel pipeline.
- `PlacedBlock` is already declarative — `FracBox` (stage fractions) + typed content +
  align/valign. It is one resolver away from being expressible as JSON.
- `formatBlocks()` (`slide-model.ts`) already prints one line per block for goldens, so a
  template's geometry is reviewable in a diff as "this box moved".
- `emit-pptx.ts` / `emit-html.ts` already key off `Role` **and nothing else**, which is what
  makes per-template roles a merge rather than a rewrite.

### What blocks "add a file = add a layout" today

- `LAYOUTS` (`layouts.ts:216`) is a hardcoded `Record<SlideLayout, fn>`; `SLIDE_LAYOUTS`
  (`slide-model.ts:62`) is a frozen six-element union.
- `TYPE_SCALE` (`deck-theme.ts`) is a `Record<Role, TypeSpec>` the emitters index directly,
  so a new role is a `.ts` edit in three files.
- `parseManifest` (`deck-build.ts:171`) validates `layout` against the static array, so an
  unknown name cannot even produce a useful "here is what IS available" message.

### The agent's cost today

Four registered tools (`archify_render`, `archify_validate`, `archify_delta`,
`archify_export_pptx`). `lintDeck` runs **only inside** `archify_export_pptx`
(`export-pptx.ts:126`) — so the only way to get writing feedback is a full build, which
renders every IR through `deliver` first. On `examples/deck/` that is 0.26 s and five
artifact renders to learn that a title reads as a label. There is no catalog surface at all:
the set of available layouts is knowable only by reading `SKILL.md`.

### Prior art in-repo that constrains this effort

- `.planning/2026-08-21-archify-slide-composition/map.md` § Fog of war already charts
  **`kpi` / `timeline` / `matrix` / `comparison`** as "the charted-but-unbuilt second round.
  Each needs its own geometry; **none needs a change to the seam**." This effort IS that
  round, and it takes that judgement as its starting hypothesis — then goes one step further
  by asking whether the geometry has to be code at all.
- `.planning/2026-08-21-archify-deck-visual-fidelity/` is **specified, 5 tickets open**, and
  records four defects found by rendering the `.pptx` through macOS's OOXML importer
  (`qlmanage`, 0.13 s/file). P2 — the action title overflows fixed chrome and is struck
  through by the theme rule — lands on **every** template that sets `chrome: true`, i.e. on
  all seven shipped here. See Fog of war and D7.

## Tickets

Phase 1 — the template seam
- `tickets/01-template-schema-and-resolver.md` — task, **done** 2026-08-23 — schema + `region/stack/repeat/box` resolver
- `tickets/02-layout-registry.md` — task, **done** 2026-08-23 — search path, precedence, role merging
- `tickets/03-bullets-equivalence.md` — task, **done** 2026-08-23 — **the vocabulary's acceptance bar** (equivalence passed first full run; no gap)

Phase 2 — the agent surface
- `tickets/04-deck-lint-tool.md` — task, **done** 2026-08-23 — `archify_deck_lint`: catalog + renderless lint

Phase 2.5 — output packaging (added 2026-08-23)
- `tickets/11-self-contained-output.md` — task, **done** 2026-08-23 — one-folder contract + spread advisory; shipped-examples conformance pinned in `tests/deck-composition.test.ts`

Phase 3 — the library
- `tickets/05-table-primitive.md` — task, **done** 2026-08-23 — `BlockContent.kind: "table"`, both emitters
- `tickets/06-template-library.md` — task, **done** 2026-08-23 — the seven shipped templates + goldens (zero `.ts` changes needed; no vocabulary gap)
- `tickets/07-example-deck-general.md` — task, **done** 2026-08-23 — 12-slide proof deck + out-of-repo template gate

Phase 4 — authoring ergonomics
- `tickets/08-outline-markdown.md` — task, open — Markdown outline → manifest
- `tickets/09-deck-scaffolds.md` — task, open — four reusable deck skeletons
- `tickets/10-docs-and-skill-split.md` — task, open — SKILL split + README + CONTEXT

**Execution order:** 08 → 09 → 10 (2026-08-23, confirm-gate fast path — fully determined: 08 `blocked-by: [02]` done → frontier; 09 `blocked-by: [08]`; 10 `blocked-by: [04, 06, 08, 09]`; no choice exists)

## Decisions

Recorded in full in `spec.md` §3. The load-bearing ones:

- **D1 — declarative containers, zero expressions.** A template composes `region` / `stack` /
  `repeat` / `box.inset`; all arithmetic lives in the resolver. Rejected: expression strings
  (`"x": "0.037 + i*0.235"`), which need a parser, cannot be schema-validated past "is a
  string", and produce bad errors. Chosen by the user 2026-08-22.
- **D2 — a template file is self-contained.** Geometry AND slots AND its own `roles` live in
  one file, with `color` restricted to existing `Palette` keys. Without per-template roles,
  "add a file" still means editing `deck-theme.ts`, and the promise fails. The Palette
  restriction is what keeps the Cardinal Rule intact.
- **D3 — code layouts outrank templates and cannot be shadowed.** The six shipped layouts win
  the name lookup unconditionally. A template that could shadow `diagram` could break the D3
  byte-identity lock from outside the repo. Cost: overriding `split`'s geometry means taking
  a new name.
- **D4 — templates recombine primitives; they do not add drawing.** A new
  `BlockContent.kind` is a `.ts` change in **both** emitters, by design. Stated in
  `CONTEXT.md` so the boundary is not rediscovered later as a limitation.
- **D5 — `table` is the one primitive added this round.** Justified by measurement, not
  taste: it is the most-used general-slide primitive and it is provably vector
  (blip 0, ooxml-lint clean — see Context).
- **D6 — no `image` this round.** Image support would force the zero-blip assertion from
  "every slide, always" down to "diagram regions only", weakening the one property a
  regression to screenshots cannot fake. The user's stated future direction is separate work:
  *fetch from the network → freeze as compact local assets → keep the bundle minimal*, with
  shapes preferred wherever a shape can express it because shapes stay editable.
- **D7 — build on the known-defective render path; absorb nothing from visual-fidelity.**
  That effort's P1/P3/P4 sit in `pptx-shapes.ts` (the diagram replay path); this effort's new
  work sits in `emit-pptx.ts` (the prose/text-box path). They do not overlap. **P2 does** —
  see Fog of war.
- **D8 — one new tool, not two.** `archify_deck_lint` is registered; the Markdown outline
  arrives as a new INPUT SHAPE on `archify_export_pptx`, not as a third tool, because the
  schema-cost canary charges every registered tool in every session.

- **D9 — self-contained output folder is a contract + advisory, not a path override**
  (added 2026-08-23). Measured root cause of the ~/proj/output spread: `resolveDeckOutput`
  and `defaultSlidesDir` already keep outputs beside the manifest — the leak was authoring
  time (absolute top-level `outputPath` in the driving prompt). Overriding explicit user
  paths would break trust; instead the skill states the one-folder rule, and
  `archify_export_pptx` attaches an advisory (text + `details.spread`) when the resolved
  output leaves the manifest dir. Advisory-only matches the `lintDeck` channel; no XML is
  touched, so the D3 byte-lock cannot notice.

## Frontier

`tickets/08-outline-markdown.md` — Markdown outline → manifest. Ticket 07 shipped the
proof deck 2026-08-23: `examples/deck-general/` exercises all seven templates beside the
code layouts — content lint clean, ooxml lint clean, one folder. To make that possible
the build path now dispatches through the registry (`registry.render` + `roleOf` into
both emitters; D3 byte-identity untouched — legacy deck still 5 slides / 388 native
shapes), and gate 5 is pinned: a template dropped into `$ARCHIFY_TEMPLATES` from outside
the repo appears in `catalog()` and renders in a built deck. The condensed skill points
at `examples/minimal.architecture.json` and the three sample decks, and states the
ask-the-catalog-first rule (D9). Suite 604 pass / 21 skip / 0 fail. Tickets 09 (deck
scaffolds) and 10 (docs/skill split) follow.

Earlier phases, closed: ticket 11 (one-folder contract; shipped-example conformance
pinned 2026-08-23), 01+02+03 (template seam; bullets-equivalence first-run pass,
timeline EXPRESSIBLE), 04 (`archify_deck_lint`; canary +248 tok), 05 (`table`
primitive), 06 (seven shipped templates + CJK goldens).

## Fog of war

- **Typo'd slot binding renders silently empty.** `{slide.rowss}` passes `validateFrom`
  (it checks token syntax, not existence) and a `table` box renders header-only — found in
  ticket-06 review 2026-08-23, consistent with `resolveBullets`' existing behaviour, so not
  a regression. If agent-authored templates become common, `validateFrom` should check the
  key against the slide record at LOAD time.
- **Custom-IR lessons from ~/proj/output not yet folded back.** The v3 run's
  `self-reflection.md` records hard-won authoring rules (no `animation:"trace"` on
  deck-facing sequence IRs; keep lifeline x clear of the segment-label span; DOM
  computed-style audit before believing screenshots) that belong in SKILL.md or the
  vendored deep guide — charted 2026-08-23, not yet landed.
- **P2 (title overflow) was a shared, unfixed defect landing on all seven templates —
  FIXED 2026-08-22 by the visual-fidelity effort (ticket 02), before any template here was
  built.** Every shipped template sets `chrome: true`, inheriting the fixed-height title
  band; the fix left `TITLE_BAND` numerically unchanged and added a build gate: a template
  sample deck carrying an over-budget title refuses to build, so author titles against
  `textEms()` (see that effort's Frontier post-mortem — three root causes, all a number
  crossing a boundary in the wrong unit). D7 stands: nothing was absorbed, P1–P3 all live
  in `pptx-shapes.ts` and are closed.
- **Whether `stack` + `repeat` alone reach `timeline`.** A timeline wants a connector rule
  spanning the full row *behind* evenly spaced stations — expressible as a sibling `box` in
  the parent region, but only if `repeat` cells and their parent can be addressed in the same
  `body`. Ticket 01 must prove this or the vocabulary needs a fourth primitive.
- **Template role collisions.** Two templates may both declare `kpiValue` with different
  sizes. Resolution is per-slide (the active template's roles win), so nothing breaks — but
  the *catalog* then reports one role name meaning two things. Not yet designed.
- **`autoPage` on tables.** `TableProps.autoPage` splits a long table across generated
  slides. That would insert slides the manifest never declared, breaking the 1:1
  slide-index ↔ manifest-entry assumption in `emit-html.ts` and the page-number chrome.
  Ticket 05 must set `autoPage: false` explicitly and assert it; not yet verified that false
  is the default.
- **Outline round-tripping is not designed.** Markdown → manifest is one-way. Whether an
  edited manifest can be re-expressed as an outline is unasked, and probably should stay
  unasked (YAGNI).
- **User template discovery on a deployed bundle.** `$ARCHIFY_TEMPLATES` and
  `<manifest dir>/templates/` both assume a writable filesystem beside the work. How this
  behaves inside the `s2-agent-sh` deploy bundle (archify ships in it as of #1783) is
  unprobed.

## Cross-effort links

- **Builds-on**: `.planning/2026-08-21-archify-slide-composition` — its `PlacedBlock` seam,
  `formatBlocks` golden format and six pure layouts are the foundation. Its Fog-of-war entry
  naming `kpi`/`timeline`/`matrix`/`comparison` as the unbuilt second round is **this
  effort's charter**; its claim that "none needs a change to the seam" is **confirmed and
  extended** — none needs a change to the seam, and none needs to be code either.
- **Shares-decision-with**: `.planning/2026-08-21-archify-deck-visual-fidelity` — its P2
  (action title overflows fixed chrome) once landed unfixed on all seven templates here;
  **it was fixed 2026-08-22 (ticket 02) before any template here was built**, leaving the
  chrome geometry unchanged and adding a title-wrap build gate the template library will
  inherit. Its D1 "the renderer sees, it never gates" is respected: every gate added by
  this effort is renderer-free. Neither effort blocks the other; the effort is fully
  closed (P1–P4 + the `deck render` seam, tickets 01–05, 2026-08-22) — its
  `bun run deck render` command is the cheap by-eye check this effort's template
  sample decks will use. Its P4 shipped `fit: "content"` on the diagram block, the
  same declarative seam this effort's templates will use to opt a template's diagram
  out of canvas fit.
- **Shares-decision-with**: `.planning/2026-08-21-archify-view-pptx-bun` — its zero-browser
  and ShapeIR decisions stand unchanged; D5 here adds the first new drawing primitive since,
  and re-verified the zero-blip property against it rather than assuming it.
