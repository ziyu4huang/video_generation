## Question

What is the `/list` command surface, and what is its relationship to `/goal` — strict superset (the active goal is always the queue head) or parallel mode?

## type: grilling

## blocked by: —

## claimed: agent (2026-07-25)
## status: closed (2026-07-25)

## Context

- core-task already has `/goal` (start/edit/pause/resume/clear/audit/…). `/list` is a sibling subcommand of the same package (reference Decision 5: one package, `/goal`+`/list`+`/loop`).
- The reference's surface: `/list` (view), items added/activated/removed, `propose_task_list` with anti-drift caps, Confirm dialog before the list is set.

## Sub-questions to resolve

1. **Command set:** `/list` (show queue), `/list add "<obj>"`, `/list next` (advance — see ticket 02), `/list remove <n>`, `/list clear`, `/list reorder`? Keep minimal (lightweight) vs match reference breadth.
2. **Superset vs parallel:** is `/goal "<obj>"` always equivalent to a 1-item list (so there's one code path), or does a standalone goal coexist with a separate queue? Reference chose shared state (one machine). Likely **superset** — simpler, matches reference — but confirm.
3. **Adding many at once:** accept a multi-line paste / array (`/list add` with several items), or one-at-a-time? Reference has `propose_task_list` (agent-drafted, Confirm-capped at 20/5).
4. **Drafting (see map fog):** does `/list add` with no objective trigger a clarify→draft flow (reference v0.2), or stay bare (`/list add "<obj>"` only) for now?

## Recommended

- **Superset:** active goal = queue head; a bare `/goal "<obj>"` is a 1-item list. One state path.
- **Minimal command set first:** `/list` (show), `/list add "<obj>"`, `/list next`, `/list remove <n>`, `/list clear`. Defer `reorder` + agent-drafted `propose_task_list` to a follow-up.
- **Bare add only** for v1 (no drafting); graduate drafting from fog if the queue proves useful.

Confirm + refine with the user.

## Resolution

**Superset + minimal 5-command surface + lossless `/list next`.** Resolved across Q1–Q3.

### Architecture (Q1 — superset)
`activeGoal` is always the live **head**; `list` is the **tail** (not-yet-activated items). A bare `/goal "<obj>"` is just `head + tail=[]` — **UX unchanged from today**. One state path; dovetails with ticket 01's storage (`GoalStateEntryData.list` = the tail).

### v1 command surface (Q2 — minimal, 5)
| Command | Effect |
|---|---|
| `/list` | show queue (head + indexed tail) |
| `/list add "<obj>"…` | append 1+ items to tail; head auto-activates if no active goal |
| `/list next` | manual advance (see Q3) |
| `/list remove <n>` | drop item by index |
| `/list clear` | wipe the queue |

### `/list next` semantics (Q3 — lossless park)
`/list next` **always** promotes the next tail item to head; the current head (any state — paused, stuck, even mid-work) is **parked at the tail, NOT dropped**. Predictable, lossless, pilot-decides. To actually discard an item, `/list remove <n>`.

### Deferred to fog / follow-up
- `/list reorder` (re-order the tail).
- Agent-drafted `/list plan` (reference `propose_task_list` with anti-drift caps + Confirm).
- Drafting (`/list add` with no objective → clarify→draft). Stays in map fog until `/list add` UX settles.

**Unblocks:** ticket 05 (widget now has the 5-command surface to display).

**Closed:** 2026-07-25.
