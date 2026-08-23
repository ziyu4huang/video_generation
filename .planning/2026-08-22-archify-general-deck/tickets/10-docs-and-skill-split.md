---
ticket: 10-docs-and-skill-split
effort: archify-general-deck
type: task
status: closed
created: 2026-08-22
last: 2026-08-23
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

## Resolution

2026-08-23 — **shipped in this PR (final queue ticket; effort close-out).** The skill split landed:
`skills/archify/SKILL.md` lost its deck section entirely (shrank to a ~3-line pointer; **no
layout list**, D9 — diagram authoring unchanged), `deck.md` (new) carries the deck writing rules,
the one build blocker (title-overflow), the one-folder rule, and the outline dialect with the
fence-vs-`!ir` precedence, and `authoring-templates.md` (new) is the ticket's real deliverable.
`docs/adr/0001-code-layouts-outrank-templates.md` (`ADR-archify-0001`, effort decision D3)
written — the three-part rule held (hard to reverse / surprising / real trade-off). README added
`archify_deck_lint` (the fifth tool), the template-library discovery, the outline door and the
skeletons; CONTEXT reconciled the four primitives (box was missing from "Region / stack /
repeat") and added two shipped terms (deck skeleton, outline dialect).

Verified: archify `typecheck` clean, `bun test` **619 pass / 21 skip / 0 fail**;
`bun run --cwd bun-apps test:adr` **17 pass / 0 fail** (the new `ADR-archify-0001` identity +
global-uniqueness validated). The change-scoped local CI and 26 regression gates passed except the
environment-only `Deploy-sh L1 e2e` (the deployed binary cannot start a session because the
environment has no authenticated/unique model provider for `glm-5.3`) — unrelated to a docs-only
change, so the PR merged with `--assume-ci-green <head sha>` per the t09 precedent. Self-sufficiency
gate evidenced by authoring a `metric-pair` template from `authoring-templates.md` alone:
`loadTemplate` accepts it and it renders 12 placed blocks. Independent reviewer subagents were
dispatched but did not settle in-session (interrupted); the source cross-check + gates above are the
record.
