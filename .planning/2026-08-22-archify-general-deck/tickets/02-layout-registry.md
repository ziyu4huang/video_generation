---
ticket: 02-layout-registry
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocked-by: [01]
blocking: [04, 06]
---
# 02 — the registry: precedence, role merging, and a useful error

> Spec §4.4–§4.5. Decisions D2, D3.

## What to build

`lib/layout-registry.ts` per spec §4.4, plus the role-resolution refactor (§4.5).

Search order — **code layouts win outright** (D3), then user tiers, then shipped:

1. the six in `layouts.ts`
2. `$ARCHIFY_TEMPLATES` (`:`-separated), then `<manifestDir>/templates/`
3. `<pkg>/templates/*.layout.json`

A template named after a code layout is a **load error**, not an override: `diagram`'s XML is
byte-locked against a pre-composition capture, and a file on a search path must not be able
to reach that. Duplicate names inside one tier are also an error — silent shadowing within a
tier is how a user's edit stops taking effect for no visible reason.

## The role refactor

`TYPE_SCALE` stops being the emitters' index and becomes the builtin base. Both emitters take
`roleOf: (role: string) => TypeSpec` = `{ ...TYPE_SCALE, ...template.roles }`. `Role` widens
to `string` **at the emitter boundary only** — `layouts.ts` keeps the narrow union internally,
so the six code layouts lose no type safety. Add `autofit?: boolean` to `TypeSpec` so a
template can opt long text into `fit: "shrink"`; `AUTOFIT_ROLES` becomes its builtin defaults.

## Wire-in

`parseManifest` (`deck-build.ts:171`) takes the registry and replaces its static
`SLIDE_LAYOUTS.includes()` check. The unknown-layout message must list what IS available —
that message is the fallback discovery path when the agent skips the catalog.

## Acceptance

- Precedence proven in both directions: a user template beats a shipped one of the same name;
  neither beats a code layout.
- `roleOf` merge: a template role overrides a builtin of the same name for that slide only,
  and the next slide is unaffected.
- `catalog()` returns `{ name, description, slots, source }` with `source` absolute.
- **Existing goldens unchanged.** The refactor is behaviour-preserving for the six; if any
  `formatBlocks` or slide-XML golden moves, stop and find out why.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
