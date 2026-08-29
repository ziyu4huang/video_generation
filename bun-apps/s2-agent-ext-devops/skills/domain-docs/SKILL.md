---
name: domain-docs
description: Use when exploring this repo's domain documentation or writing domain docs — the L1/L2/L3+Z progressive-disclosure doc map (root CONTEXT.md / CONTEXT-MAP.md, per-package CONTEXT.md, docs/adr/), the CONTEXT.md glossary-purity rule, and the ADR-<context>-NNNN citation convention that `bun run test:adr` enforces.
---

# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

This repo uses a **progressive-disclosure** doc map (L1 → L2 → L3, plus a
cross-cutting state view) — read only the depth your task needs:

| Depth | Doc | Read it when… |
|-------|-----|---------------|
| **L1** system overview | root **`CONTEXT.md`** (glossary) + **`CLAUDE.md`** | you need the overall shape / ubiquitous language |
| **L2** component overview | per-package **`CONTEXT.md`** (e.g. `bun-apps/<pkg>/CONTEXT.md`) | you're changing one package's behavior — start with its glossary |
| **L3** deep decision | **`docs/adr/`** (and `src/<context>/docs/adr/` in multi-context repos) | you need to understand *why* a design choice was made |
| **𝒵** cross-cutting state | **`bun-apps/s2-agent-ext-devops/skills/shared-state-index/SKILL.md`** | your change touches shared config / resolution rules consumed by >1 package |

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.
- **`bun-apps/s2-agent-ext-devops/skills/shared-state-index/SKILL.md`** — cross-package shared state (vault root resolution, model dirs, venv, workspace root). Check this before assuming where output lands or where config is read from.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

> **Glossary purity.** The root `CONTEXT.md` is a glossary only — definitions, no
> implementation details (file paths, config keys, code). A per-package `CONTEXT.md`
> follows the same rule **with one sanctioned exception**: each term may carry a
> single `_Source_:` anchor in `file#symbol` form (the only implementation detail
> allowed) — see `/domain-modeling`. All other implementation-level concerns belong
> in `docs/adr/`, the `shared-state-index` skill, or code comments.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Cite ADRs by context-qualified ID, never by bare number

Every context numbers its own ADRs from `0001`. In a multi-context repo that
means the bare number identifies **nothing**: in this repo the number 0001 names
seven different documents and every number in use collides at least twice.

Cite `ADR-<context>-NNNN`, derived from the path:

```
src/ordering/docs/adr/0007-event-sourced-orders.md   →   ADR-ordering-0007
bun-apps/s2-agent-ext-wayfind/docs/adr/0004-...      →   ADR-wayfind-0004
```

Each ADR declares that ID on its first line. A bare number is acceptable only
*inside its own context*, where it resolves locally.

`bun run test:adr` (from `bun-apps/`) blocks on any citation that does not
resolve to exactly one ADR — including a reference to a number the citing
context has never had. This is enforced because getting it wrong is not
theoretical: a bare, un-qualified citation was once resolved to the wrong
document, and a genuine architecture violation was allowlisted as a "false
positive" on the strength of it.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts `ADR-orders-0007` (event-sourced orders) — but worth reopening because…_
