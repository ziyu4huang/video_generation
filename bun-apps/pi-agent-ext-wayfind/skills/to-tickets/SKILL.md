---
name: to-tickets
description: Use when breaking an agreed spec into tracer-bullet tickets under `.planning/<effort>/tickets/` — artifact contract + chain wiring. Invocation via `/wayfind tickets`.
disable-model-invocation: true
---

# To Tickets

Break a spec (or settled map decisions) into **tracer-bullet tickets** — one file per ticket, each a complete vertical slice declaring its blocking edges. Use the project's domain glossary (`CONTEXT.md`) vocabulary, and respect ADRs in the area you're touching.

Slicing and planning methodology: see the superpowers **writing-plans** and **subagent-driven-development** skills.

## Artifact contract: `.planning/<effort>/tickets/<NN>-<slug>.md`

- One file per ticket, numbered from `01` in dependency order (blockers first) — never a single combined file.
- Each ticket is a **vertical slice**: a narrow but COMPLETE path through every layer (schema, API, UI, tests), demoable or verifiable on its own, sized for a single fresh context window (wide refactors are the exception: sequence them expand–contract).
- Declare **blocking edges** — the tickets that must complete first; a ticket with no blockers omits the `blocking:` line and can start immediately. Work the **frontier** (any ticket whose blockers are all done), one ticket at a time, clearing context between tickets.

Unified per-ticket format (the exact schema `parseTicketFile` reads):

<local-ticket-template>

---
type: task
blocking: 02, 05
status: open
---

# <NN> — <Ticket title>

## Question
The decision this ticket resolves, or the slice's scope — one sentence.

## What to build
The end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

## Acceptance
- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-ticket-template>

## Chain wiring

Input: `spec.md` / wayfinder map decisions (`/wayfind spec` precedes). Output: `/wayfind seed <effort>` flattens the frontier into `task_plan.md` — one phase per ticket (topo-sorted by `blocking`), `[NN-slug]` phase headers, acceptance criteria carried through — then execute per ticket (executing-plans / subagent-driven-development); when a phase completes, `/wayfind sync` closes the originating ticket.
