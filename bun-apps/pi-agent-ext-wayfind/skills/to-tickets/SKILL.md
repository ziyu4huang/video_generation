---
name: to-tickets
description: Use when breaking an agreed plan, spec, or conversation into tracer-bullet tickets — each a complete vertical slice declaring its blocking edges. Writes one file per ticket under .planning/<effort>/tickets/. Invocation via `/wayfind tickets` (or load the skill directly).
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it. Each ticket lands as its own file under `.planning/<effort>/tickets/`, numbered from `01` in dependency order.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path) as an argument, read its full body. Use the project's domain glossary (`CONTEXT.md`) vocabulary throughout, and respect ADRs in the area you're touching.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state. Look for opportunities to prefactor the code to make implementation easier: "make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**: expand (add the new form beside the old so nothing breaks) → migrate call sites in batches, each batch its own ticket blocked by the expand, keeping CI green because the old form still exists → contract (delete the old form once no caller remains). When even the batches can't stay green alone, let them share an integration branch that all block a final integrate-and-verify ticket.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Write the tickets to local files

Write one file per ticket under `.planning/<effort>/tickets/<NN>-<slug>.md`, numbered from `01` in dependency order (blockers first), so each ticket's blocking edges can reference the numbers/titles it depends on. Use the per-ticket template below — **one ticket per file, never a single combined file.**

<local-ticket-template>

# <NN> — <Ticket title>

---
type: task
blocking: 02, 05      # the ticket ids (NN) that gate this one; omit the line if none
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

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype.

Work the **frontier** — any ticket whose blockers are all done — one ticket at a time, clearing context between tickets.

### Seed the plan

Flatten the frontier into a `task_plan.md` with **`/wayfind seed <effort>`** — one phase per ticket (topo-sorted by `blocking`), `[NN-slug]` phase headers, acceptance criteria carried through. This is the bridge from wayfind's decision artifacts into the plan coordinator's execution substrate. Then execute the plan to activate the hooks; when a phase completes, `/wayfind sync` (or any `/wayfind*` touchpoint) closes the originating ticket.
