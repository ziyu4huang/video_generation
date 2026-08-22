---
ticket: 10-docs-and-skill-split
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocked-by: [04, 06, 08, 09]
---
# 10 — the surface: skill split, README, CONTEXT

> Spec §4.10. Decision D9.

## What to build

```
skills/archify/SKILL.md               diagram-first; deck shrinks to ~3 lines + a pointer
skills/archify/deck.md                deck writing rules, outline dialect, "ask the catalog first"
skills/archify/authoring-templates.md NEW — how to write a *.layout.json
```

**`SKILL.md` must not list the layouts** (D9). It says: call `archify_deck_lint` with no
arguments. A hardcoded list is wrong the moment a user drops a template on the search path,
and being wrong there is worse than being absent — the agent will believe it.

`authoring-templates.md` is the ticket's real deliverable. It carries: the four primitives
with one worked example each, the `Palette`-key restriction on `roles.color` and why (the
Cardinal Rule), the search path and its precedence, the fact that a new **drawing primitive**
is a `.ts` change in both emitters while a new **arrangement** is a file (D4), and the load-
time error list so a failure is self-diagnosing.

Also update: `README.md` (templates section, the fifth tool, the outline door),
`CONTEXT.md` (the *Layout template* / *Slot* / *Region-stack-repeat* / *Drawing primitive*
terms are already written — reconcile them with what actually shipped), and add
`bun-apps/s2-agent-ext-archify` to `bun-apps/docs/adr/INDEX.md` if this effort produced an
ADR.

## Should this effort produce an ADR?

Test D3 against the three-part rule (`ADR-FORMAT.md`): hard to reverse — **yes**, the
precedence order is baked into every template file's assumptions once they exist; surprising
without context — **yes**, "code beats data" reads backwards until you know about the
byte-identity lock; a real trade-off — **yes**, the cost is that `split`'s geometry can never
be overridden in place. Three for three: write `docs/adr/0001-code-layouts-outrank-templates.md`
in the archify context, and cite it as `ADR-archify-0001`.

## Acceptance

- `bun run test:adr` (from `bun-apps/`) green — no unresolved ADR citations.
- No layout list in `SKILL.md`.
- A fresh reader can write a working template from `authoring-templates.md` alone, without
  reading `lib/layout-template.ts`.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
plus `bun run --cwd bun-apps test:adr`.
