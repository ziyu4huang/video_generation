---
effort: 2026-08-23-ticket-execution-loop
created: 2026-08-23
last: 2026-08-23
status: complete
---
# ticket-execution-loop — user-chosen ticket order + next-goal self-loop

## Destination

Multi-ticket efforts execute in a **user-chosen order**: after `/wayfind seed` the agent presents
the derived order with hard `blocking:` edges marked and asks confirm-or-rechoose; the chosen
order is recorded in the effort map and mirrored by the devops next-goal file. The effort
**self-loops to completion**: every ticket boundary writes a successor next-goal file whose head
is the next ticket, "hands on next goal" resumes the queue head (fresh session or in-session
continuation), and the loop **terminates with an effort close-out** when the queue drains.

## Context (measured 2026-08-23 in this worktree)

- **The derived order is never presented for confirmation.** `/wayfind seed` topo-sorts tickets
  over their `blocking:` edges (DFS post-order, ascending id as secondary key —
  `bun-apps/s2-agent-ext-wayfind/src/chain.ts:106-121`) into `task_plan.md` phase order;
  `executing-plans` then loads, reviews, creates todos, proceeds — no order checkpoint, no
  close-out queue awareness (step 1 / step 3 of
  `bun-apps/s2-agent-ext-superpowers/skills/executing-plans/SKILL.md`).
- **The handoff already flavors toward queues ad-hoc.** `output/next-goal-20260823-135435.md`
  (today 13:54): Immediate steps = ticket 08 (`archify-general-deck` effort), Done when =
  ticket-08 acceptance, Ranked = 09/10 + audit items. No boundary discipline (supersede at each
  ticket boundary, not just session end), no queue-drain termination, no link back into the
  effort map.
- **The order is a genuine choice.** Only hard `blocking:` edges are forced; e.g.
  `general-deck` ticket 09 "only get useful after 08" is a soft preference, not an edge —
  exactly the latitude a user should decide.
- **The validator pins the format exactly** (`bun-apps/s2-agent-ext-devops/src/validate-next-goal.ts`):
  five `##` headings in fixed order (:26), exact frontmatter key set — no extras (:34), Done
  when ≥1 open box (:158-162), Ranked next goals 3–5 numbered entries (:166-168). Queue mode
  must fit inside that shape: no new headings, no new frontmatter keys.
- **map.md `## Tickets` prose is parser-inert.** `readMap` derives tickets from the
  `tickets/NN-slug.md` **directory** (`src/map.ts:75-93`), not from map.md bullets — so an
  `**Execution order:**` line inside `## Tickets` cannot break any map consumer
  (`effort-tool.ts` uses readMap at :90/:113/:171; `parseTicketFile` reads ticket files only).
- **Hardening verification gate already exists** for the format this effort extends:
  `bun-apps/s2-agent-ext-devops/tests/validate-next-goal.test.ts` + the RUNNABLE doctor
  `bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts`.

## Tickets

Phase 1 — the gate
- `tickets/01-order-gate-wayfind.md` — task, **closed** — to-tickets chain-wiring gate + ask-matt flow bullets + map.md record

Phase 2 — the executor
- `tickets/02-executor-side-superpowers.md` — task, **closed** — executing-plans Step-1 checkpoint + queue-aware close-out; SDD Finish paragraph

Phase 3 — the loop
- `tickets/03-queue-mode-devops.md` — task, **closed** — self-reflect-next-goal queue mode (READ/WRITE/EXECUTE + termination); devops-workflow cross-ref

## Decisions

- **D1 — confirm-gate at start.** Before any execution the agent presents the derived order,
  marks hard `blocking:` edges (no choice) and parallelizable pairs (choice), and asks
  confirm-or-rechoose; single-ticket / fully-determined queues get a one-line confirm. Reason:
  the order is a real choice only where edges don't force it; ask once at start, not at every
  boundary (user decision 2026-08-23).
- **D2 — write + continue if fresh at boundaries.** Always supersede the next-goal file at a
  ticket boundary (the loop's carry); continue to the next ticket in-session while the session
  is fresh (stop at the boundary near the smart zone ~140-150k used), else stop so "hands on
  next goal" resumes the file. Reason: per-ticket context hygiene without forfeiting auto-run
  when the session has room (user decision 2026-08-23).
- **D3 — the chosen order is recorded as one `**Execution order:**` line inside map.md
  `## Tickets`** (parser-inert, measured above), mirrored by the next-goal Ranked list. Reason:
  map.md is the sole durable home; `output/` next-goal files are per-worktree gitignored scratch.
- **D4 — no format changes to the next-goal validator.** Queue mode lives inside the existing
  shape (facts under the five existing headings). Reason: the validator is the trust boundary —
  its tests pin exact keys/headings because prose templates drifted before (v1).
- **D5 — doc-only; no code changes.** Reason: presenting the order and carrying the queue are
  procedure; `seed` already computes the suggested order (`flattenTicketsToPlan` topo order).

## Frontier

ticket 01 — the gate is the loop's entry point; 02 and 03 read the order it enforces.

## Fog of war

- **No origin effort found for the next-goal format in `.planning/`** — grep for
  next-goal/self-reflect over `.planning/` and the `2026-08-20-devops-hardening` effort hit
  nothing, so no cross-effort link is claimed. The READ of `LATEST-next-goal.md` (whose
  realization is visible in `output/`) is the current source of truth.
- **Baseline compliance was not measured for the old wording.** Per superpowers
  `writing-skills` TDD the ideal is a no-skill baseline; here we run a single with-skill
  pressure probe (see `spec.md` Testing Decisions) as the first compliance signal.
- **`Execution order` line placement conventions** — first effort to use one; no prior art on
  wording to imitate.

## Cross-effort links

- `Builds-on:` `2026-08-20-devops-hardening` (name from the `.planning/` listing only) — the
  hardening effort is presumed to own the next-goal validator/v2 shape this effort extends, but
  no reference was found in its files; verify before relying on the link. (Fog of war, above.)
