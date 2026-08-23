---
effort: 2026-08-23-cc-parity-task-ext
created: 2026-08-23
last: 2026-08-23
status: open
---
# cc-parity-task-ext — align ask_user_question / /loop / wizard to Claude Code behavior

## Destination

`s2-agent-ext-task`'s `ask_user_question` tool, `/loop` command, and wayfind's `wizard`
skill behave the way Claude Code's equivalents do — same tool schema semantics, same
command surface, same authoring conventions — so muscle memory and model behavior
transfer between the two agents. `/goal` (a Claude Code nonexistent) stays as-is and
loses its dead coupling to the old loop.

## Context (measured 2026-08-23 on this machine)

- **ask_user_question lives in `bun-apps/s2-agent-ext-task/src/ask-user/`** — 4,796
  lines across tool/ state/ view/. Schema facts (`tool/types.ts:11-14`):
  `MAX_QUESTIONS=4`, `MIN_OPTIONS=2`, `MAX_OPTIONS=4` (both already CC-parity),
  `MAX_HEADER_LENGTH=16` (CC: **12**), `MAX_LABEL_LENGTH=60` hard limit (CC: no hard
  limit, guidance is "concise 1-5 words").
- **Recommended-option convention diverges.** s2-agent has a `recommended: boolean`
  schema field with a ⭐ prefix (`tool/types.ts:53-58`); Claude Code has **no field** —
  the model suffixes the label with "(Recommended)" and places it first.
- **preview is unrestricted here, single-select-only in CC.** CC renders previews as
  markdown in a monospace box with a side-by-side layout; our schema description says
  only "mockups, code snippets, or visual comparisons" (`tool/types.ts:47-52`).
- **Tool description lacks CC's plan-mode guidance** (clarify BEFORE entering/exiting
  plan approval; never ask "is the plan ready"). s2-agent-ext-task has its own plan
  subsystem (`src/plan/`) the guidance should reference.
- **`/loop` is a process-improvement loop, not CC's recurring-execution loop.**
  `src/loop/` = 760 lines: `start/stop/status` + `measure=<cmd>` + plateau detection +
  anti-repetition, ticked from goal's `agent_end` (`goal/hooks.ts:254-255`). CC's
  `/loop <interval> <prompt|slash-cmd>` (default 10m) re-enqueues a prompt on a timer,
  firing only while the REPL is idle. Four goal⇄loop coupling sites exist:
  `goal/hooks.ts:254`, `goal/lifecycle.ts:54`, `goal/status.ts:116`, `goal/status.ts:129`.
- **Claude Code has no `/goal` command** (verified first-hand from the CC harness's own
  command surface, 2026-08-23; background research pending as confirmation). s2-agent's
  `/goal` (auditor/reviewer/shield/quota-retry, 5,184 lines) is a superset — untouched.
- **wizard teaches bash.** `s2-agent-ext-wayfind/skills/wizard/` = SKILL.md +
  `template.sh` (stage library, `bash -n` + shellcheck verification). Repo rule: Bun
  scripts replace bash where the repo owns the convention.
- **CC scheduler semantics that /loop mirrors** (from the CC harness, first-hand):
  session-only jobs die with the process; the 7-day auto-expiry belongs to durable
  cron files, not session timers; one-shot vs recurring; jobs fire only while idle.
- **Gates.** `s2-agent-ext-task`: `bun run typecheck && bun test`. `s2-agent-ext-wayfind`:
  `bun run check && bun run test:unit && bun run test:probe`.

## Tickets

Phase 1 — ask_user_question parity
- `tickets/01-ask-user-cc-parity.md` — task, **open** — schema + description + TUI alignment

Phase 2 — wizard Bun port
- `tickets/02-wizard-bun-template.md` — task, **open** — template.sh → template.ts + SKILL.md rewrite

Phase 3 — /loop replacement
- `tickets/03-loop-cc-scheduler.md` — task, **open** — timer scheduler replaces process loop; goal decoupled

## Decisions

D1–D7 in `spec.md` §3. The shape-givers:

- **D2 — recommended moves from schema field to label-suffix convention.** CC parity
  means the model writes "(Recommended)" suffix + first position; the TUI detects the
  suffix and still renders ⭐ (suffix stripped from display), so nothing visual regresses.
- **D3 — /loop is replaced, not adapted.** Old `start "target" measure=…` syntax is
  dropped with no compat layer (user decision 2026-08-23); the process-improvement
  semantics had no CC counterpart and the mutual-exclusion seam with goal was pure cost.
- **D5 — /goal stays.** CC has no /goal; ours is a superset. Only the four dead coupling
  sites to the old loop are removed.

## Frontier

`tickets/01-ask-user-cc-parity.md` — it is self-contained, touches no other subsystem,
and its schema changes unblock the TUI work in the same ticket. Tickets 02/03 are
independent of it and of each other.

## Fog of war

- **Preview side-by-side rendering** — `view/components/preview/` current capabilities
  not yet audited against CC's monospace-markdown side-by-side box; ticket 01 must
  measure before promising TUI changes beyond the ⭐ suffix swap.
- **CC `/goal` research confirmation** — background research agent pending; first-hand
  harness surface already shows none. If research surfaces one, D5 is revisited.
- **Dynamic self-pacing (CC ScheduleWakeup equivalent)** — deliberately uncharted:
  needs an agent-callable reschedule tool; `/loop <interval>` covers the stated use
  case. Chart if a real need appears.
- **Slash-command targets for /loop** — CC's /loop accepts `<slash-command>` as target;
  whether s2-agent's command registry can be invoked programmatically from an
  extension is unprobed. Ticket 03 ships prompt targets; slash targets follow if the
  probe succeeds.
- **Label hard limit** — CC has none; we keep a widened guardrail so TUI wrap tests
  stay meaningful. Exact number decided in ticket 01 against the wrap tests.

## Cross-effort links

- **Builds-on**: `.planning/2026-08-22-subagent-cc-parity-2` — same parity intent
  (Claude Code as reference agent) applied to the subagent subsystem; this effort
  extends it to the task cockpit. Shares the "parity ledger in spec.md" convention.
- **Shares-decision-with**: `.planning/2026-08-21-archify-slide-composition` — both
  hold "measured-first" Context sections; wizard Bun port follows the same
  template-invariants pattern (library above a marker never hand-edited).
