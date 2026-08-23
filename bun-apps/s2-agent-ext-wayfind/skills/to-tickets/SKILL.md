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

Input: `spec.md` / wayfinder map decisions (`/wayfind spec` precedes). Output: `/wayfind seed <effort>` flattens the frontier into `task_plan.md` — one phase per ticket (topo-sorted by `blocking`), `[NN-slug]` phase headers, acceptance criteria carried through — then, **after the execution-order confirm-gate below**, execute per ticket (executing-plans / subagent-driven-development); when a phase completes, `/wayfind sync` closes the originating ticket.

## Execution order — the confirm-gate

The seed's phase order is the **suggested** order — derived (`topo-sort` over `blocking:`), not chosen. The order is a real choice only where blockers don't force it, and the user decides.

After `/wayfind seed <effort>`, BEFORE any execution starts:

1. **Present** the suggested phase order with, per ticket:
   - **hard** `blocking:` edges — marked "no choice" (the ticket's blockers must precede it);
   - **choice** pairs — tickets with no edge between them (incl. soft preferences like "X is more useful after Y"), marked "your call" and whether the tickets are parallelizable.
2. **Ask confirm-or-rechoose.** A single open ticket, or a queue where every order is forced by `blocking:` edges, is fully determined → one-line confirm, not a full prompt.
3. **Record the choice**: one `**Execution order:** 08 → 09 → 10` line inside the effort's `map.md` `## Tickets` section (parser-inert — `readMap` derives tickets from the `tickets/` dir; the line is human-facing + mirrored by the devops next-goal file's Ranked list).
4. Deviations users pick are honored — but a choice that contradicts a `blocking:` edge is surfaced, not silently accepted (the user may still override; the executor then flags the blocked dependency).
5. Execute the chosen order, one ticket at a time. Between tickets the carry is the devops next-goal file (see `self-reflect-next-goal`): each ticket boundary supersedes `output/LATEST-next-goal.md` with the next ticket as `Immediate steps` — "hands on next goal" resumes the queue head; the loop ends with an effort close-out when the queue drains.

## Dispatch discipline

When this skill dispatches subagents: superpowers:dispatch-recovery is the
single source (trust rules, janitor-first recovery, verbatim-apply, ledger).
Size BEFORE sending — maxTurns >= task steps + 2, tokenBudget by tier ceiling;
author content parent-side (verbatim-apply) and put all reads in turn 1
(mega-block).
