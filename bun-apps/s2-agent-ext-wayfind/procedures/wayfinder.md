# Wayfinder

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** of **decision tickets** on disk, then works the tickets — questions whose resolution is a decision, not slices of a build to execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is a file, so it has a **name** — its title. In everything the human reads — narration, the map's Decisions-so-far — refer to it by that name, never by a bare number or slug. A wall of `#42, #43, #44` is illegible; names read at a glance. The number doesn't vanish — a name wraps its file link — but it rides *inside* the name, never stands in for it.

## Decision forks → ask_user_question

At every decision fork — naming the destination, choosing or confirming a ticket, and **especially the next-goal pick after the closing ceremony** — present the choice via the **`ask_user_question` tool** with a recommended (⭐) option, never a prose menu. The ceremony's harvested `nextGoal` is the recommended option; the other deferred prizes plus a fresh effort are the alternatives. This mirrors grilling's one-question-at-a-time discipline: a prose menu forces the human to parse unparsed options, while the tool gives clean, selectable choices with a visible recommendation.

## Fact freshness

The working tree reflects the *current branch*, which may lag the line of development (`origin/<default>`). A map built on facts gathered from a stale tree rests on a false premise — wasted work that only surfaces at commit time. The `/wayfind` command checks this at start and warns when the branch is behind; heed it: warn the human and prefer rebasing before charting. If you reach this skill without the command, run `git rev-list --count HEAD..origin/<default>` yourself — if the count is non-zero, flag it before gathering facts.

## The Map

The map is a single file `.planning/<effort>/map.md` — the canonical artifact. Its tickets are files under `.planning/<effort>/tickets/`.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are open ticket files, found by scanning the `tickets/` dir.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then open the link for the detail the ticket holds -->

- [<closed ticket title>](tickets/NN-slug.md) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is a file `.planning/<effort>/tickets/NN-slug.md`; the filename `NN` is its identity (zero-padded, dependency order). Its body is the question, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Each ticket carries a `type:` — one of `research`, `prototype`, `grilling`, `task` (see [Ticket Types](#ticket-types)).

A session **claims** a ticket by adding a `claimed:` line with a label (the dev/agent driving the map) **first**, before any work, so concurrent sessions skip it. That claim _is_ the lock: an open, unclaimed ticket is unclaimed.

Blocking uses **text edges** — each ticket lists `blocked by:` the ticket numbers/titles that must close before it can start. (There is no native tracker dependency link in the local-markdown store, so the frontier is computed, not rendered by a UI — `/wayfind status` does this.) A ticket is **unblocked** when every ticket blocking it is closed; the **frontier** is the open, unblocked, unclaimed tickets — the edge of the known.

The answer isn't part of the body — it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the issue, not pasted in.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked *with* a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources like knowledge bases to surface a fact a decision waits on. Resolved by a research pass via the `web_search` / `fetch_content` tools (or a `workflow` subagent). Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation via the `grilling` and `domain-modeling` skills, one question at a time. The default case.
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that *does* rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, **graduating** whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Lifecycle status

Every wayfinder effort carries a lifecycle status in its `map.md` front-matter
manifest: `active` (the default, scaffolded on chart/create), `complete`, or
`paused`. The status lives on `map.md`; for **hybrid** efforts (map +
spec/plan/sdd) the map is canonical. Superpowers-only efforts (no `map.md`) and
leftovers are **not** tagged — they are classified by content (`COMPLETED.md` /
landed SDD), not a status field.

`/wayfind done` is the **canonical close**: after its closing ceremony it writes
`status: complete` **and** moves the effort into `.planning/done/`. `done/`
membership is itself the complete signal (location-as-status) — the archive is
not backfilled. A stale stub filed without reaching its destination is `paused`
(there is no separate "abandoned" value). `wayfind_effort status` reports the
manifest; `validate` checks it.

**Prefer the `wayfind_effort status` tool action for inventory/audit** over
reading whole `map.md` / ticket files: it returns a budget-bounded low-res view
(manifest status + counts + a per-ticket `{id,title,status,blocking}` inventory)
with NO verbatim decision bodies — so it can't exhaust the token budget (failure
memory #455). Subagents have no `/wayfind` slash commands, so `status` is their
only bounded view; reach for it first, then read only the specific ticket you'll
act on.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Chart the map

User invokes with a loose idea. If the destination's first word collides with a reserved keyword (`status`/`spec`/`tickets`/`seed`/`sync`/`done`/`handoff`/`validate`/`help`/`usage`), chart it with `/wayfind -- <destination>` so the name isn't taken for a subcommand.

1. **Confirm fact freshness.** If the `/wayfind` command warned the branch is behind `origin/<default>`, tell the human and prefer rebasing first — see **Fact freshness** above. A map charted on a stale premise is wasted work.
2. **Name the destination.** Run a `grilling` and `domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
3. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear, the whole journey small enough for one session — you don't need a map. Stop and ask the user how they'd like to proceed.
4. **Create the map** (`.planning/<effort>/map.md`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
5. **Create the tickets you can specify now** as files under `tickets/` — then wire `blocked by:` edges in a **second pass** (tickets need numbers before they can reference each other). Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
6. **Fire the research passes.** For each `research` ticket you just created, run a `web_search`/`workflow` research pass to resolve it in parallel, capturing its findings as a ticket answer.
7. Stop — charting is one session's work; it hand-resolves nothing.

### Work through the map

User invokes with a map (path) or an effort slug. A ticket is **optional** — without one, you pick the next decision, not the user.

1. **Load the map** — the low-res view, not every ticket body. If the `/wayfind` command warned the branch is behind `origin/<default>`, flag it before resolving — see **Fact freshness**.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: add a `claimed:` line before any work.
3. **Set a `/goal`** with the ticket's title as the objective and its acceptance criteria as completion targets. This activates plan-mode coordination (`goal_complete` gating, `todo` tracking, progress publishing via `__piPlan*` seams) so mid-resolution tooling works correctly. Use the built-in goal-setting mechanism (the tool or command that creates the active goal).
4. Resolve it — **zoom as needed**: read the full body of any related or closed ticket on demand; invoke the skills the `## Notes` block names. If in doubt, use `grilling` and `domain-modeling`. For **Task** tickets, call `goal_complete` when the deliverable is met — the goal gate validates plan completion before the ticket can close.
5. Record the resolution: append the answer as a **resolution** to the ticket, mark it **closed**, and **append a pointer** to the map's Decisions-so-far. The goal auto-closes with `goal_complete`; no separate cleanup needed.
6. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

### Re-applying a fix? Investigate why the last one didn't stick first

When a ticket's resolution is re-applying a fix that an earlier session (or you) already applied but is no longer present, **don't just re-apply it** — root-cause it first, or it vanishes again. Before re-patching: check `git log -p -- <path>` for whether it was reverted (and why); confirm the prior fix had a test (no test = nothing guards the same reversion); verify you're patching the layer the fix belongs in (a fix on a generated/vendored layer that gets overwritten is a no-op); and make sure you're on the worktree/branch you think you are (a stale worktree turns a "live" fix into a phantom). Cite the memory, commit, or diff as evidence — failure memories **#276/#279**: the agent re-applied a patch without investigating why the prior one was unapplied. If you can't answer *why it didn't stick*, the re-patch is premature — add a ticket for the root cause instead.

**When the map is complete** — the frontier is clear and the destination is reached — run `/wayfind done [effort]` (the command refuses if open tickets remain). It harvests the map's **Not yet specified** as deferred prizes and writes `output/next-goal-<YYYYMMDD_HHMMSS>.md` with the structured parts pre-filled (you fill only the reflective parts — false premises / footguns — that you alone know), then runs `scripts/tidy-next-goals.sh` (keeps the last 10). The command also stamps `status: complete` on the manifest and files the effort into `.planning/done/` (the canonical close — see [Lifecycle status](#lifecycle-status)). If the command is unavailable, do the same by hand: surface false premises / footguns / deferred prizes, pick the next concrete non-gated non-conflicting goal. This closing ceremony is the structural home of the convention — not a memory to recall.

**When the session ends while tickets are still open** — the standing rule (2026-08-23): a session never just stops with open wayfind tickets. Run `/wayfind handoff [effort]`: it carries every open ticket into `output/next-goal-<YYYYMMDD-HHMMSS>.md` in the strict v2 next-goal contract (devops `self-reflect-next-goal` — frontmatter `file/created/supersedes`, five exact sections, validator-passing, LATEST pointer re-set), pre-filling Honest gaps / Immediate steps / Done when from the map's open tickets + frontier. Fill **Verified this session** with real evidence before you stop, then validate with `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts`. `done` closes a FINISHED effort; `handoff` preserves an UNFINISHED one — neither is optional.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the map dir concurrently. The concurrency model is **last-write-wins** — there is no file lock (see [ADR-0005](../../docs/adr/0005-accept-last-write-wins-planning-concurrency.md)): collisions are rare because a fresh dated effort dir per `/wayfind` isolates concurrent sessions by default, `.planning/` is git-committed (the recovery net), and any code-level guard could not cover the agent's own `edit`-tool writes to the same files anyway. Use distinct effort dirs when you need true isolation.
