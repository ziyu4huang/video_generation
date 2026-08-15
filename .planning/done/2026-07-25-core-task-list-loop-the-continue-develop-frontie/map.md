> STATUS: DONE — archived 2026-08-15 (triage verdict: /list goal queue Loop 2 shipped (#826))
# Wayfinder map: 2026-07-25-core-task-list-loop-the-continue-develop-frontie

## Destination

Design **Loop 2 (`/list` — a queue of goals)** for `pi-agent-ext-core-task`: multiple objectives排队, completing one activates the next, on top of the now-hardened single-goal machine (#814 + #818, on main). **Output = a spec handoff for `writing-plans`** — not the build itself. Loop 3 (metric-driven forever) is out of scope here (fog; graduates after Loop 2 lands).

## Notes

- **Domain:** core-task goal loop (`bun-apps/pi-agent-ext-core-task/src/goal/`).
- **Consult the reference:** `../pi-goal-list-loop-audit/` — esp. `extensions/loops/goal.ts` (the proven loop-1+2 consolidation), `extensions/goal-loop-core.ts` (shared state), `docs/DESIGN.md` Decisions 5 (one package, `/goal`+`/list`+`/loop` subcommands), 7 (loops 1+2 share ONE state machine), 8 (status machine).
- **Skills every session should consult:** `grilling`, `domain-modeling`.
- **Standing preferences (binding):**
  - core-task stays a **lightweight cockpit** — `/list` must be **opt-in, zero default cost** (lazy), never a default-on supervisor.
  - **Goal state stays in session-store** (`appendEntry`), NOT `.planning/` or a custom JSONL (project rule).
  - Auditor stays **inline** (in `goal_complete`) + **lazy-imported**; no new `auditing` status.
  - `globalThis` coordination seams are intentional — preserve.
- **Reference shipped this incrementally:** v0.1 (loop 1) → v0.2 (loop 2 /list) → v0.3 (loop 3 /loop). core-task is at the v0.2 on-ramp.

## Decisions so far

<!-- one line per closed ticket; gist + link -->

- [Scope = Loop 2 only](tickets/00-scope-loop2-only.md) — chart `/list` queue; Loop 3 (metric forever) deferred to fog; standing-architecture is a separate map.
- [Queue storage = session-store via extended `GoalStateEntryData`](tickets/01-queue-storage.md) — add `list?` to the entry + `list` to `GoalRuntimeState`; no new status states; one-entry-holds-whole-queue (matches reference single-state model).
- [Auto-advance = hybrid, single behavior](tickets/02-auto-advance-vs-explicit.md) — clean complete (incl. audit `impossible`→complete-with-note) auto-promotes next; pause/failure freezes the queue (`/list next` to advance); no `--no-auto` knob (creating the list is the opt-in). Unblocks ticket 04.
- [`/list` = superset + minimal 5-command surface](tickets/03-list-command-surface.md) — `activeGoal`=head, `list`=tail; bare `/goal` is `tail=[]` (UX unchanged). Commands: `/list` / `/list add "<obj>"…` / `/list next` (lossless park-at-tail) / `/list remove <n>` / `/list clear`. Defer reorder + `/list plan` + drafting. Unblocks ticket 05.
- [Queue audit = per-item flag, 02's rules govern](tickets/04-per-goal-audit-in-queue.md) — each `GoalListItem` carries `audit?` (incl. `auditorModel`), plumbed into `createGoal` on promotion; audit mechanism itself unchanged (T04 #818 as-shipped); advance/freeze per ticket 02.
- [Widget = dim suffix `☰ N/M`, total<2 hidden](tickets/05-queue-visibility-widget.md) — `formatGoalOverlayLine(…, queue?: {position,total,parked?})`; shown only when `total≥2` (bare `/goal` byte-identical); narrow terminals drop queue before truncating head; full list in `/list`.

---

**🗺️ Map complete — all 6 tickets closed. Frontier clear; destination reached.**

**Spec + plan written (the destination deliverable):**
- `bun-apps/pi-agent-ext-core-task/docs/2026-07-25-list-loop-spec.md` — consolidated design (6 decisions → architecture/data-model/wiring/testing).
- `bun-apps/pi-agent-ext-core-task/docs/2026-07-25-list-loop-plan.md` — 7 TDD tasks (data model → list.ts → persistence → commands → /list handlers → goal_complete auto-advance → widget).

Next: execute the plan (SDD recommended). Deferred prizes: Loop 3 (metric forever), drafting phase (see Not yet specified).

## Not yet specified

<!-- fog toward the destination; graduates as the frontier advances -->

- **Loop 3 (`/loop` — metric-driven forever):** orchestrator runs the user's `measure` command after each `agent_end`; agent never self-reports; termination by plateau / iteration-cap / `/loop stop`; NO auditor (metric is the verdict); optional `branch=1` scratch-branch mode (reference v0.3/v0.4). **Graduation criterion:** after Loop 2 lands and the queue+machine feel right in practice. Don't pre-slice — one fog patch for now.
- **Drafting phase:** reference v0.2 added a `/goal` (no args) → clarify → `propose_goal_draft` Confirm-dialog flow. core-task has no drafting. May belong to Loop 2 (helps queue items be well-formed) or stay separate — revisit when the `/list add` UX (ticket 03) settles.

## Out of scope

<!-- ruled beyond the destination; closed, never graduates -->

- **Standing architecture** (separate future map): superpowers-status full integration, obsidian vault-root in pi config, inspect/CONTEXT tooling, deploy single-exec-binary. Each is its own effort — this map is core-task only.
- **Loop 3 (`/loop` metric forever)** — this map is Loop 2. It lives in **Not yet specified** (in-scope fog), not here; it graduates into its own tickets later, not by expanding this map's destination.
