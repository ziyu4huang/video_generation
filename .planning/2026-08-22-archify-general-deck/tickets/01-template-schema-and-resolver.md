---
ticket: 01-template-schema-and-resolver
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocking: [02, 03, 06]
---
# 01 — the template contract and its resolver

> Spec §4.1–§4.3. Work this as one unit with 02 and 03; ticket 03 is the acceptance bar.

## What to build

`templates/layout-template.schema.json` and `lib/layout-template.ts`.

The schema is the contract from spec §4.1: `name` / `description` / `chrome` / `slots` /
`roles` / `body`. The resolver exports one function:

```ts
export function loadTemplate(json: unknown, source: string): LoadedTemplate;  // throws TemplateError
```

`LoadedTemplate.render(slide, ctx)` walks `body` depth-first carrying an `InchBox` scope and
returns `PlacedBlock[]` **built with the same `at()` / `text()` constructors `layouts.ts`
uses** — extract them to a shared module rather than reimplementing, or a template's blocks
will drift from a code layout's in exactly the ways `formatBlocks` cannot show.

Four primitives, nothing else (spec §4.2): `region` · `stack` · `repeat` · `box`.
Two regions: `content` (takeaway-aware, `y` 1.4 / 1.5) and `full`. `CONTENT` is deliberately
NOT a region — it belongs to the D3 lock.

**All arithmetic lives here.** `stack` divides a box by weights minus gaps; `repeat` divides
by count minus gaps. A template file must never contain a number that depends on a count.

## Answer this first

**Can `stack` + `repeat` express `timeline`?** A timeline wants a connector rule spanning the
full row *behind* evenly spaced stations. That needs a sibling `box` and a `repeat` addressing
the same parent region in one `body` — which the design implies but has not been walked
through. Sketch `timeline`'s `body` on paper before writing the resolver. If it does not
express, the vocabulary needs a fourth primitive and that is cheaper to learn now than at
ticket 06.

## Error surface (all LOAD-time, never render-time)

- `name` matching a code layout, or not `^[a-z][a-z0-9-]*$`
- `roles.*.color` not a `Palette` key
- a `from` token outside `{field}` / `{slide.<key>}` / `{index0}` / `{index1}`
- `repeat.over` naming an undeclared slot
- `content.kind` no emitter knows
- an unknown `region`

Each error names the file, the JSON path, and what was expected.

## Acceptance

- Accept/reject pairs for every error class above; each error message names its source file.
- A `formatBlocks` golden per primitive under `__tests__/fixtures/templates/`.
- No import of `pptxgenjs`, no colour literal, and no emitter import in `layout-template.ts`
  — same discipline `layouts.ts` holds.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
