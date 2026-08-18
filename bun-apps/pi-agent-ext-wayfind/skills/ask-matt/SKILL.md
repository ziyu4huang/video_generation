---
name: ask-matt
description: Use when you don't remember which wayfind skill or flow fits your situation — a router over the wayfind family (grilling, wayfinder, to-spec, to-tickets, handoff, triage, codebase health). Methodology questions route to the superpowers using-superpowers skill.
disable-model-invocation: true
---

# Ask Matt

You don't remember every skill, so ask.

A **flow** is a path through the skills. Most paths run along one **main flow**, and three **on-ramps** merge onto it. Everything else is standalone, or a vocabulary layer that runs underneath.

> **Methodology (brainstorm → plan → TDD → debug → review)?** That vocabulary lives in superpowers — use the **using-superpowers** skill. This router covers the wayfind family only.

> **Skill index rebuilt for this port.** Every reference below is a skill in this extension's `skills/` dir — the `executing-plans`, `test-driven-development`, and `systematic-debugging` skills live in the sibling **superpowers** extension.

## Redirects (skills merged into superpowers)

These wayfind skills were removed on 2026-08-16; their methodology was merged
into the sibling **superpowers** extension (one methodology home — see
ADR-wayfind-0007 and the plan at
`.planning/plans/2026-08-16-solution-extension-simplification.md`). One
release of grace for muscle memory — the table is deleted at the next wayfind
release marker: **`0.2.0`**, the first version bump after `0.1.0` (see
`docs/versioning.md`):

| If you reached for… | Use instead (superpowers) |
|---|---|
| `research` | `dispatching-parallel-agents` (background research subagent + cited findings artifact) |
| `prototype` | `brainstorming` (prototype pointer section) |
| `subagent-dispatch-discipline` | `dispatching-parallel-agents` (pre-dispatch guardrails) |
| `code-review` | `requesting-code-review` + `receiving-code-review` (Standards-vs-Spec dual axis) |
| `diagnosing-bugs` | `systematic-debugging` (reproduction-loop engineering) |
| `writing-for-agents` | `writing-skills` (generalized to all agent-consumed docs) |

Upstream re-sync note: each row above was deliberately removed 2026-08-16,
superseded by its superpowers counterpart — do NOT re-port/re-add these skills
from Matt Pocock's upstream suite (era simplification, ADR-wayfind-0007).

## The main flow: idea → ship

The route most work travels. You have an idea and want it built.

1. **grill-me-with-docs** — sharpen the idea by interview. Start here whenever you are **working in a working directory**: it's stateful, retaining what it learns in `CONTEXT.md` and ADRs. (No working directory? Use the **grill-me** skill — see Standalone. Both run the same **grilling** primitive; `grill-me-with-docs` is the one that leaves a paper trail, which makes it the better of the two whenever a repo is there to leave it in.)

2. **Branch — can you settle every question in conversation?** If a question needs a runnable answer (state, business logic, a UI you have to see), detour through a prototype — the how lives in the superpowers **brainstorming** skill, routed via **using-superpowers** — bridged by the **handoff** skill in both directions: handoff out to a fresh session, answer it in throwaway code, handoff back what you learned and reference it from the original idea thread (see Phase boundaries).

3. **Branch — is this a multi-session build?**
   - **Yes** → the **to-spec** skill (turn the thread into a spec), then **to-tickets** to split it into tracer-bullet tickets, each declaring its **blocking edges**. That's one file per ticket under `.planning/<effort>/tickets/`, worked blockers-first; any ticket whose blockers are done can be grabbed — kick off the superpowers **executing-plans** skill per ticket, handing off / starting a fresh session between each one. Each ticket is self-contained, so the last one's context is disposable.
   - **No** → the superpowers **executing-plans** skill right here, in the same session.

   How executing-plans builds each ticket (TDD slices, code review) is superpowers methodology — methodology routing lives in superpowers:using-superpowers; do not re-add here.

### Context hygiene

Keep steps 1–3 in **one unbroken session** — don't hand off or start fresh until after `to-tickets` — so the grilling, spec, and tickets all build on the same thinking. Each executing-plans then starts fresh, working from the ticket.

The limit on this is the **[smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone)**: the window (~150k tokens on state-of-the-art models) within which the model still reasons sharply. If a session approaches it before `to-tickets`, don't push on degraded — use the **handoff** skill at the nearest phase boundary to compact and continue fresh (see Phase boundaries).

## On-ramps

A starting situation that generates work, then merges onto the main flow.

- **Bugs and requests piling up** → **triage**. It moves issues through triage roles and produces agent-ready briefs, which **executing-plans** later picks up. Triage is only for issues **you didn't create** — bug reports, incoming feature requests, anything that arrives raw. Tickets that `to-tickets` produced are already agent-ready, so **don't triage them**.

- **Something's broken** → the superpowers **systematic-debugging** skill — for the bug that resists a first glance, the intermittent flake, the regression between two known-good states; its post-mortem can hand off to **improve-codebase-architecture** when the finding is a missing seam. Methodology routing lives in superpowers:using-superpowers — do not re-add here.

- **A huge, foggy effort — a greenfield project or a huge feature build, too big for one session** → the **wayfind effort-map** (the `wayfinder` procedure at `procedures/wayfinder.md`, driven by the **`/wayfind`** command; described in the extension's `CONTEXT.md`). When the way from here to the destination isn't visible yet, it charts a **shared map** of **decision tickets** under `.planning/<effort>/` and resolves them one at a time — producing **decisions, not deliverables** — until the fog is pushed back and the way is clear. Where **grill-me-with-docs** sharpens an idea you can hold in one session, wayfinder is for the idea you can't — and it's slower and denser, so save it for exactly that, never a well-scoped feature.

  When the map clears, **it hands off, it doesn't build**: merge onto the main flow at **to-spec**, which collapses the map's linked decisions into a buildable plan, then `to-tickets` and executing-plans as usual. Looping the map straight into executing-plans skips that collapse and throws the linked detail away — go straight to executing-plans only when the effort turned out genuinely small.

## Codebase health

Not feature work — upkeep.

- **improve-codebase-architecture** — run whenever you have a spare moment to keep the codebase good for agents to operate in. It surfaces **deepening opportunities**; picking one _generates an idea_ you can take into the main flow at `grill-me-with-docs`. It's the survey that finds the candidates; the **codebase-design** skill (below) is the bench you design the chosen one on.

## Vocabulary underneath

Two model-reachable references that run *beneath* the other skills — each the single source of truth for its vocabulary. Reach for them directly when the **words**, not the process, are the problem; or let the skills above pull them in.

- **domain-modeling** — sharpen the project's *domain* language: challenge a fuzzy term, resolve an overloaded word ("account" doing three jobs), record a hard-to-reverse decision as an ADR. It's the active discipline `grill-me-with-docs` drives to keep `CONTEXT.md` a clean glossary.
- **codebase-design** — the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) for designing a module's *shape*: a lot of behaviour behind a small interface at a clean seam. The `test-driven-development` skill and `improve-codebase-architecture` both speak it.

## Phase boundaries

A **phase** is a chunk of work inside a session — the grilling, the implementation, the QA. At the **boundary** between two of them you have five options, and picking between them is the fuzziest decision in this whole map:

- **Continue** — stay in the session. Costs nothing, loses nothing.
- **Fresh session** — start a new session carrying nothing, when nothing here matters to what's next.
- **handoff** — write a portable markdown file with the handoff skill. Narrow: only for **switching harnesses**, a **new directory**, a **colleague**, or forking a side task **mid-phase**. What it buys is portability.
- **Subagent** — dispatch a subagent with a tightly-scoped task and get a report back.
- **handoff + fresh** — compact this context with the handoff skill and continue in a fresh session. The **default**, at the bottom of the tree rather than the first reach.

Read [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md) for the ordered tree — the five questions, the reasoning behind each branch, and why the primary-source cost makes **Continue** the one to rule out first. Make the decision **at** a boundary; mid-phase, continue or split the rest into subagents.

## Standalone

Off the main flow entirely.

- **grill-me** — the same relentless interview as `grill-me-with-docs`, but **stateless**: it saves nothing locally and builds no `CONTEXT.md`. Reach for it when you are **not working in a working directory** — sharpening a plan, a design, a piece of writing, anything with no repo under it. If you are in a working directory, use `grill-me-with-docs` instead: it runs the same interview and leaves a paper trail, so it is strictly the better one.
- **grilling** — the interview primitive itself: rounds, the frontier, facts are the agent's job and decisions are yours. `grill-me` and `grill-me-with-docs` are the two named ways in, and `improve-codebase-architecture` runs it internally. Reach for it directly only when you want the interview with no wrapper around it.
- **resolving-merge-conflicts** — work an in-progress merge or rebase conflict hunk by hunk, resolving by **intent** traced to each side's primary source rather than by picking lines, then finish the operation. It never runs `--abort`. Standalone and off every flow: reach for it when you are already mid-conflict.
- **to-questionnaire** — when the thing blocking you isn't in your head or the codebase but in **someone else's**, this writes them a questionnaire to fill in. It's the inverse of `grill-me`: instead of interviewing you about the subject, it interviews you about the **send** — who it's going to, what you need back — and aims the questions at the gap. What comes back is material for `grill-me-with-docs` or `to-spec`.
- **wizard** — for the steps only a **human** can take: provisioning infrastructure, setting up credentials or CI secrets, clicking through an unfamiliar third-party dashboard, running a one-off migration or cutover. It generates an interactive bash script that opens each URL, captures each value, and writes it into `.env` and GitHub secrets — so the procedure stops being something you re-explain to an agent every time. Model-reachable, so the agent reaches for it the moment it hits a wall only you can pass. If the agent could just do it itself, it should; this is for where a human is genuinely in the loop.
- **teach** — learn a concept over multiple sessions, using the current directory as a stateful workspace.
- **wait-what** — a message did not land. Stop and re-pitch it from scratch in Simplified Technical English using the project's ubiquitous language — a sentence of context, where you are, what's next, nothing else. The conversational repair when you (or the user) lost the thread.

## Dispatch discipline

When this skill dispatches subagents: superpowers:dispatch-recovery is the
single source (trust rules, janitor-first recovery, verbatim-apply, ledger).
Size BEFORE sending — maxTurns >= task steps + 2, tokenBudget by tier ceiling;
author content parent-side (verbatim-apply) and put all reads in turn 1
(mega-block).
