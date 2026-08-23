---
ticket: 05-table-primitive
effort: archify-general-deck
type: task
status: done
created: 2026-08-22
last: 2026-08-23
blocking: [06]
---
# 05 — `table`: the one new drawing primitive

> Spec §2.3, §4.6. Decisions D4, D5.

## Why this is a `.ts` change and the other six templates are not

Templates recombine primitives; they do not add drawing (D4). `table` is a genuinely new
`BlockContent.kind` and therefore lands in **both** emitters. It is the only such change this
effort makes, and it is justified by measurement rather than taste (§2.3):

```
addTable(rows, opts)  →  <a:tbl> inside <p:graphicFrame>
<a:blip>              0          ← the acceptance property holds
lintPptx              clean      ← the existing gate already accepts graphicFrame
59 860 B, 10.1 ms                (3×3 CJK table, probed 2026-08-22)
```

## What to build

```ts
| { kind: "table"; columns: string[]; rows: string[][]; role: Role; headerRole: Role }
```

- **pptx**: `slide.addTable(rows, { ...box, colW, fontFace, fontSize, border, fill,
  autoPage: false })`. Header row bold via `headerRole`.
- **html**: a `<table>` inside the positioned div, painted from the same two roles.

## `autoPage: false` is not optional

`TableProps.autoPage` splits a long table across **generated** slides. That inserts slides the
manifest never declared, which breaks the 1:1 slide-index ↔ manifest-entry assumption in
`emit-html.ts` and in the page-number chrome (`n / N` would be computed from a count that no
longer matches). Set it explicitly, assert it in the emitted XML, and do **not** rely on false
being the library default — that has not been verified.

Over-long tables are a `deck-lint` advisory (row count), not an emitter behaviour.

## Acceptance

- `<a:tbl>` present, `<a:blip>` = 0, `lintPptx` clean on a slide carrying a table.
- A table with more rows than fit produces **one** slide, never two.
- The HTML twin and the pptx agree on column count, header text, and cell order.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
