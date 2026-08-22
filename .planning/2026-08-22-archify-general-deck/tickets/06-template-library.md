---
ticket: 06-template-library
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocked-by: [01, 02, 03, 05]
---
# 06 — the seven shipped templates

> Spec §4.7. Do not start before ticket 03 is green: a vocabulary gap found here invalidates
> seven files at once.

## What to build

`templates/*.layout.json`, one per row, plus a `formatBlocks` golden each under
`__tests__/fixtures/templates/`:

| name | slots | geometry |
|---|---|---|
| `kpi-row` | `kpis[]{value,label,note?}` (2–4) | `repeat` row over `content` |
| `table` | `columns[]`, `rows[][]`, `note?` | one `box`, `kind:"table"` |
| `compare` | `left{heading,bullets}`, `right{…}` | `stack` col 50/50 |
| `timeline` | `milestones[]{date,label,note?}` (3–6) | spanning rule + `repeat` row |
| `agenda` | `items[]{title,note?}` (3–8) | `repeat` col, `{index1}` numbering |
| `quote` | `quote`, `attribution`, `role?` | centred box + rule + attribution |
| `end` | `headline`, `contact?` | `full` panel + centred type |

## Two things to get right

**`quote` vs `statement`.** `statement` is the presenter's own claim; `quote` is somebody
else's words, attributed. Keep them distinct in the `description` field — that string is what
the agent reads from the catalog, and it is the only thing stopping `statement` from being
abused for citations.

**`compare` is 50/50, `split` is 60/40.** That is deliberate, not an inconsistency: `split`
weights a diagram against its commentary, `compare` weights two peers. Say so in its
`description`.

## Acceptance

- All seven load with zero diagnostics and appear in `catalog()`.
- One golden per template; each renders with a realistic CJK payload, not lorem.
- **Zero `.ts` changes in this ticket.** If one is needed, the vocabulary is short — go back
  to ticket 01 and record the gap in `map.md` § Fog of war rather than patching it here.
- Two templates declaring the same role name resolve per-slide with no leakage (the collision
  case flagged in `map.md` § Fog of war — at minimum, prove it does not break).

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
