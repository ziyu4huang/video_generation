# Wayfind skill — findings (task: working-dir-users-huangziyu-proj-video-g)

READ-ONLY investigation. Budget exhausted before full cross-referencing; core artifact was fully read.

## (a) Exact file path(s) read

- **Main artifact (fully read):** `bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md` (162 lines) — this is the Wayfinder procedure that governs working/continuing an effort. There is NO `skills/wayfind/SKILL.md`; the wayfind workflow lives in `procedures/wayfinder.md` plus `src/` TS tooling (`commands.ts`, `map.ts`, `effort-query.ts`, etc.).
- Partially scanned: `bun-apps/pi-agent-ext-wayfind/README.md` (command table), `skills/wizard/SKILL.md` (unrelated — bash wizard for HITL manual procedures).
- Skill folders under `bun-apps/pi-agent-ext-wayfind/skills/`: ask-matt, code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-me, grill-me-with-docs, grilling, handoff, improve-codebase-architecture, prototype, research, resolving-merge-conflicts, subagent-dispatch-discipline, teach, to-questionnaire, to-spec, to-tickets, triage, wait-what, wizard, writing-for-agents. (None matched "wayfind continue" verbatim in the partial grep pass.)

## (b) Load-bearing rules (verbatim excerpts from procedures/wayfinder.md)

### One-ticket-per-session norm
> Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Frontier / ticket selection & confirmation
> The answer isn't part of the body — it's recorded on resolution… Blocking uses **text edges** — each ticket lists `blocked by:` the ticket numbers/titles that must close before it can start. … A ticket is **unblocked** when every ticket blocking it is closed; the **frontier** is the open, unblocked, unclaimed tickets — the edge of the known.

> 2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: add a `claimed:` line before any work.

> A session **claims** a ticket by adding a `claimed:` line with a label (the dev/agent driving the map) **first**, before any work, so concurrent sessions skip it. That claim _is_ the lock: an open, unclaimed ticket is unclaimed.

### Decision forks → ask_user_question (HITL confirmation ritual)
> At every decision fork — naming the destination, choosing or confirming a ticket, and **especially the next-goal pick after the closing ceremony** — present the choice via the **`ask_user_question` tool** with a recommended (⭐) option, never a prose menu.

### Map.md update format
Map body (verbatim template):
```markdown
## Destination
<what reaching the end of this map looks like…>
## Notes
<domain; skills every session should consult; standing preferences…>
## Decisions so far
<!-- one line per closed ticket -->
- [<closed ticket title>](tickets/NN-slug.md) — <one-line gist of the answer>
## Not yet specified
<!-- in-scope fog you can't ticket yet; graduates as the frontier advances -->
## Out of scope
<!-- work ruled beyond the destination; closed, never graduates -->
```
> The map is an **index**, not a store. … a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.
> Open tickets are **not** listed — they are open ticket files, found by scanning the `tickets/` dir.

Resolution recording (step 5 of "Work through the map"):
> Record the resolution: append the answer as a **resolution** to the ticket, mark it **closed**, and **append a pointer** to the map's Decisions-so-far.

Ticket file format: `.planning/<effort>/tickets/NN-slug.md`, body `## Question <the decision or investigation this ticket resolves>`, carries `type:` one of research/prototype/grilling/task; sized to one 100K-token agent session.

### Ticket types (incl. prototype-style)
> - **Research** (AFK): … Resolved by a research pass via the `web_search` / `fetch_content` tools (or a `workflow` subagent).
> - **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code. Links the prototype as an asset.
> - **Grilling** (HITL): Conversation via the `grilling` and `domain-modeling` skills, one question at a time. The default case.
> - **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made … This is the one type that *does* rather than decides — and it earns its place by unblocking a decision… Resolved when the work is done; the answer records what was done and any resulting facts later tickets depend on.
> A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it.

### Plan-don't-do (governs "execute/land"-style work inside the map)
> Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

### Completion / exit criteria
> **When the map is complete** — the frontier is clear and the destination is reached — run `/wayfind done [effort]` (the command refuses if open tickets remain). It harvests the map's **Not yet specified** as deferred prizes and writes `output/next-goal-<YYYYMMDD_HHMMSS>.md` … then runs `scripts/tidy-next-goals.sh` (keeps the last 10). The command also stamps `status: complete` on the manifest and files the effort into `.planning/done/` (the canonical close).

Lifecycle: `active` (default) / `complete` / `paused` in map.md front-matter manifest; `/wayfind done` is canonical close (status + move to `.planning/done/`); "location-as-status", archive not backfilled.

### Refer by name
> In everything the human reads — narration, the map's Decisions-so-far — refer to it by that name, never by a bare number or slug.

### Fact freshness (continue-time check)
> The `/wayfind` command checks this at start and warns when the branch is behind; heed it: warn the human and prefer rebasing before charting. If you reach this skill without the command, run `git rev-list --count HEAD..origin/<default>` yourself — if the count is non-zero, flag it before gathering facts.

### Concurrency
> The concurrency model is **last-write-wins** — there is no file lock (see ADR-0005)… Use distinct effort dirs when you need true isolation.

### Re-applying a fix ritual
> When a ticket's resolution is re-applying a fix… **don't just re-apply it** — root-cause it first… check `git log -p -- <path>`… (failure memories #276/#279).

## (c) "Continue" entry point — step by step ("Work through the map", verbatim steps)

Precondition: user invokes with a map (path) or effort slug; ticket optional — "without one, you pick the next decision, not the user."

1. **Load the map** — the low-res view, not every ticket body. If the `/wayfind` command warned the branch is behind `origin/<default>`, flag it before resolving (Fact freshness).
2. **Choose the ticket.** If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: add a `claimed:` line before any work.
3. **Set a `/goal`** with the ticket's title as the objective and its acceptance criteria as completion targets — activates plan-mode coordination (`goal_complete` gating, `todo` tracking, `__piPlan*` seams).
4. **Resolve it** — zoom as needed: read full bodies of related/closed tickets on demand; invoke skills named in `## Notes`; default to `grilling` + `domain-modeling`. For **Task** tickets, call `goal_complete` when the deliverable is met.
5. **Record the resolution**: append answer as resolution to the ticket, mark closed, append pointer to map's Decisions-so-far. Goal auto-closes.
6. **Update the map**: add newly-surfaced tickets (create-then-wire `blocked by:` edges in a second pass); graduate fog from **Not yet specified** into tickets (clearing each graduated patch); rule out-of-scope tickets by closing them + one line in Out of scope; update/delete invalidated tickets.

Then: when frontier is clear and destination reached → `/wayfind done [effort]` closing ceremony (refuses if open tickets remain).

## Not yet covered (budget exhausted)
- Verbatim reads of `skills/to-tickets/SKILL.md`, `skills/triage/SKILL.md`, `skills/prototype/SKILL.md` — "build/prototype"- vs "execute/land"-style ticket phrasing grep was aborted; note the repo's `.planning/` standing rule (CLAUDE.md) says wayfind efforts use the map+decision shape above, while SDD efforts (`sdd/`, tickets with build/land phases) live under `.planning/<effort>/sdd/` governed elsewhere (superpowers package, `bun-apps/pi-agent-ext-superpowers/` — not scanned).
- README.md command table (scanned): `/wayfind [destination]` chart; no-args = work next frontier ticket; `status|spec|tickets|seed|sync|done|validate` subcommands; chain: grill docs → wayfind spec → wayfind tickets → wayfind seed → execute the plan → wayfind sync.
