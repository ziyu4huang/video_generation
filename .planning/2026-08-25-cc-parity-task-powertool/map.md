---
effort: 2026-08-25-cc-parity-task-powertool
created: 2026-08-25
last: 2026-08-28 (ticket 04 closed — pathology episode note model-visible opt-in, PR #2113)
status: active
---

# Wayfinder map: 2026-08-25-cc-parity-task-powertool

## Destination

The ext-task and power-tool surfaces read like Claude-Code's to a model or
user who knows CC: the plan coordinator gains a real approval gate
(ExitPlanMode-shaped) instead of a passive phase-counter; ONE task-tool
family with CC semantics (effective-blocked deps, symmetric edges,
workflow-discipline description); ONE `/loop` mechanism (ultracode's
WakeupRegistry) instead of two; pathology findings can reach the model
(opt-in); a `/cost`-style session accumulator exists; the trends engine's
verdict math is sound (no partial-window verdicts, new-failure-modes
detected); and the deferred structural debt (goalState partition, dock
wire-or-delete, Reviewer default) is resolved. s2-only advantages (auditor,
quota-retry, pathology engine, browser token economy) stay.

## Context (measured 2026-08-25 on this machine — 4-way parallel code review, anchor claims re-verified first-hand; bug batch already landed as PR #2030, merged 3fca5a00)

- **Plan coordinator is passive** — parses `.planning/<effort>/map.md` +
  `plans/*.md` phases (`src/plan/coordinator.ts:67`, parse.ts), gates only
  negatively (`goal_complete` blocked while incomplete, goal-complete-tool
  → internals). No Enter/Exit approval, no read-only planning; the auditor's
  "read-only" grant includes `bash` (`auditor.ts:185`, prompt-level
  "Never modify files" only). Repo grep: no ExitPlanMode anywhere in bun-apps.
- **Two task families model-visible** — `todo` flat action-discriminated
  mega-tool (todo.ts:34-61; flat root is load-bearing: z.ai GLM 400s on
  `anyOf` roots, types.ts:99-104) vs `task_create/get/list/update` over
  TeamTaskStore (ext-subagent task-tools.ts:124-233, workflow-gated). todo
  gaps: no effective-blocked selector (completed deps still render `⛓ #1`),
  one-way edges (no addBlocks), no spinner wiring for activeForm, no
  discipline rules in the description (stealth-trimmed snippet by design).
- **ask-user: notes now reach the model** (fixed PR #2030); remaining:
  no "only-ask-when-genuinely-the-user's" guideline; validation failures
  set `cancelled:true` + no `isError` on error envelopes (todo's too).
- **Two `/loop`s** — ext-task LoopScheduler (fixed 1m–23d cadence,
  idle-postpone, session-store restore, PR #2030 fixed the restore cadence
  + unref) vs ext-ultracode `/loop` + `schedule_wakeup` (60–3600s clamp,
  dynamic pacing, fire cap 50, ticket 06 of subagent-cc-parity-2). Same
  command name, papered by `/loop:2` redirect (loop-commands.ts:73-79).
- **Pathology is status-line-only by design** (warning.ts:74; CONTEXT.md
  "Proactive warning … never injects") — the model cannot learn it is
  looping. Warning count freezes at first-warn; `STATUS_KEY` is global so
  a child clobbers the parent's line.
- **No session cost/duration/turn accounting anywhere** (grep: no
  totalCost/cumulative/sessionCost; turn counter exists in pathology).
- **Trends math** — verdicts on a partial final window (aggregate.ts:130-139,
  needs only baseline minEvents + ≥2 windows); zero-baseline new checks read
  "insufficient signal" (aggregate.ts:137-139); `SessionScan` carries no
  sessionId so the sidecar gitSha join is impossible (sidecar.ts:35 vs
  scan.ts:62-75, readSidear has zero non-test consumers).
- **Detectors** — no quota/429 channel (provider errors never enter
  PathologyInput, types.ts:27-33); exact argsSig only (near-identical args
  defeat it); `KNOWN_EVENTS` hand-pinned "pi 0.82.0" vs dep 0.84.2
  (runner-hooks.ts:14-31) — latent unknown-event false positives.
- **Structural debt** — goalState process singleton cross-contaminates
  in-process children (state.ts:149-152, ticket #16; todo already fixed via
  per-session buckets + renderSid); dock focus pair built+ADR'd+tested but
  unwired (dock.ts + dock-claim.ts, 314 lines, zero production callers;
  task.ts:110-114 uses neither setNotifyLine nor setDockState); Reviewer
  default-on regex auto-enqueue without Confirm (reviewer.ts, 4 rounds of
  false-positive patches v0.26.3–v0.28.24); regression-shield branch
  unreachable (`verificationContract` settable by nothing, ~150 lines).
- **inspect_context** — buckets are % of current usage not the window, no
  free-space row, "Conversation + other" absorbs all estimation error
  (inspect-context.ts:103-116).
- **browser** — no `find` over the stored snapshot, no first-class dialog
  handling, no network-request surface; the playwright-cli skill is a
  parallel stack (deliberate per its frontmatter, 2026-08-20 operator call).
- Baseline at chart time: ext-task 893 pass, power-tool 248+4 skip,
  core-interface 56 pass, tsc ×3 clean, seam gate 8 pass (this Linux box).

## Tickets

**Execution order:** 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 (user-confirmed 2026-08-25 via the confirm-gate; hard edge: 06 → 07 — verdict math must be sound before commit-boundary comparisons consume it; all other pairs are choice, default ordered by parity impact).

**Phase 1 — CC parity features (high)**

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-plan-approval-gate.md` | closed | ExitPlanMode-shaped approval surface on the plan coordinator: plan content shown → user approval gates implementation; read-only enforcement during planning; drop `bash` from the auditor's read-only grant — shipped via PR #2075 |
| `tickets/02-task-family-convergence.md` | closed | ONE model-visible task family with CC semantics — D7: TeamTaskStore `task_*` won (core-gated everywhere), `todo` retired to a TUI face; effective-blocked deps, discipline text, isError envelopes |
| `tickets/03-loop-consolidation.md` | closed | Retire ext-task LoopScheduler into ultracode's WakeupRegistry (the CC-faithful core), porting idle-postpone + restart-restore; ext-task keeps only the composite-widget section + `/loop` redirect — shipped via PR #2108 |
| `tickets/04-pathology-model-visible.md` | closed | Opt-in (`BUN_PI_PATHOLOGY_INJECT=1`) once-per-episode turn-boundary injection via `before_agent_start` message; warning count refresh per evaluation; per-session status key `pi-pathology:<sid>` — shipped via PR #2113 |
| `tickets/05-cost-accounting.md` | pending | `/cost`-style session accumulator in power-tool: cumulative spend + duration + turn count on `after_provider_response`, surfaced via a tool/command and inspect_agent |

**Phase 2 — analytics correctness (power-tool)**

| Ticket | Status | Summary |
|---|---|---|
| `tickets/06-trends-verdict-math.md` | pending | aggregate(): recent-window floor before regressed/improved verdicts; zero-baseline + hot-recent = "new"/regressed verdict instead of insufficient-signal |
| `tickets/07-history-commit-join.md` | pending | sessionId in SessionScan + sidecar join in agent-trends + `--since-sha`/`--before-sha` segmentation — answers "did my change regress behavior" at a commit boundary |
| `tickets/08-detector-coverage.md` | pending | quota/429 observation channel into PathologyInput; near-identical-args no-progress detector (digit/whitespace-normalized argsSig); KNOWN_EVENTS type-level drift guard vs the SDK union |

**Phase 3 — structural + policy (deferred from the review)**

| Ticket | Status | Summary |
|---|---|---|
| `tickets/09-goal-state-partition.md` | pending | Key goalState by sessionId like todo's buckets (closes ext-task ticket #16); fold noProgress* counters into goalState so `__resetGoalState` is complete |
| `tickets/10-dock-wire-or-delete.md` | pending | Wire the dock focus claim into extensions/task.ts (onTerminalInput seam) or delete dock.ts + dock-claim.ts + ADR-task-0001 — 314 dead lines either way |
| `tickets/11-reviewer-shield-policy.md` | pending | Reviewer default → off (keep opt-in; 4-round false-positive history); regression shield: add `/goal --verify` or delete the unreachable branch |
| `tickets/12-inspect-context-framing.md` | pending | Window-relative bucket percentages + free-space row + honest "residual (est. error included)" labeling for bucket C |
| `tickets/13-browser-cc-surfaces.md` | pending | browser_find over the stored snapshot, first-class dialog handling, network-request inspection surface (extends the power-browser-tool surfaces) |

## Decisions

- D1 (2026-08-25, charting): review-first execution — the verified-bug
  batch (ask-user notes→LLM, closePage proxy, loop restore cadence, unref
  timers, dead seams, doc drift) landed BEFORE this effort as PR #2030;
  this effort owns parity features + structural work only, not re-review.
- D2 (2026-08-25, charting): pathology model-visibility is OPT-IN
  (`BUN_PI_PATHOLOGY_INJECT`-style env), preserving the documented
  non-invasive default (CONTEXT.md "Proactive warning"); parity lands as
  an option, never a silent default flip.
- D3 (2026-08-25, charting): loop consolidation direction — ultracode's
  WakeupRegistry is the surviving core (more CC-faithful: clamps, dynamic
  pacing, fire cap); ext-task's LoopScheduler contributes idle-postpone +
  restart-restore semantics, then retires. The `/loop` command name lands
  on ONE implementation.
- D4 (2026-08-25, charting): the task-family bug is HAVING TWO model-visible
  families, not which one wins — ticket 02 must end with exactly one
  model-visible family; the other becomes TUI-only or is deleted.
- D5 (2026-08-25, charting): ledger split — the standing subagent ledger
  (`.planning/2026-08-23-subagent-cc-parity-2/spec.md`) stays authoritative
  for subagents/workflows/cron; THIS effort's spec.md is the ledger for
  the task/power-tool domains and inherits its maintenance rule (every
  parity ticket updates its tables in-PR).
- D6 (2026-08-25, charting): the Reviewer flips default-off in ticket 11
  unless field evidence surfaces against it — its own changelog (four
  false-positive rounds) is the evidence; it overlaps the repo's real
  planning layer (wayfind/`.planning/`).
- D7 (2026-08-27, ticket 02): the task-family convergence lands on
  TeamTaskStore — ext-subagent's `task_create/get/list/update` (already CC
  vocabulary, symmetric cycle-checked edges) becomes the ONE model-visible
  family, core-gated in every session shape; ext-task's `todo` mega-tool is
  retired to a TUI face (`/todos` + composite widget render the shared board
  through `board-view.ts`). Reason: splitting `todo` into four tools would
  leave TWO visible families in workflow sessions (the team board cannot be
  un-registered — children coordinate through it), and the actual bug was
  "no shared state", which only store convergence fixes. The ticket-#16
  per-session isolation died WITH the private-scratchpad design it protected;
  sharing is CC-faithful (CC's subagents share the task list).

## Frontier

Ticket 05 (cost accounting) — ticket 04 closed 2026-08-28 (PR #2113, squash
`0a8fe360`, merged CLEAN, local_ci pass 88s): the pathology engine gained an
opt-in model-visible path (`BUN_PI_PATHOLOGY_INJECT=1`, D2 — default OFF
keeps the non-invasive status-line contract, test-pinned through the full
factory): detection arms a once-per-episode pending note, the factory's
`before_agent_start` handler delivers it as a `pathology-note` CustomMessage
at the turn boundary (cannot fire mid-stream — chosen over
`sendMessage`+`deliverAs:"nextTurn"` after investigating both; fog entry
resolved). Adjacent bugs fixed: warning count now refreshes every evaluation
(×3→×8 no longer freezes at first-warn) and the status key is
sessionId-qualified (`pi-pathology:<sid>`, per-session episode maps mirror
the accumulator) so subagent children no longer overwrite the parent's line.
05 is the last open Phase-1 ticket and blocks nothing (06 → 07 is the only
hard edge, inside Phase 2).

## Fog of war

- Micro-compaction of stale tool outputs (CC's "[File previously read]")
  — genuinely missing repo-wide, but it belongs to `s2-agent-ext-compact`,
  NOT this effort; chart it there if pursued.
- ~~Whether pi's SDK exposes a turn-boundary context-injection seam usable
  by ticket 04~~ RESOLVED 2026-08-28 (ticket 04): `before_agent_start`
  returning `{ message }` is the seam — emitted in `agent-session.js` after
  the user message is queued, before the agent loop starts (cannot fire
  mid-stream); chosen over `sendMessage`+`deliverAs:"nextTurn"`.
- Whether ultracode's WakeupRegistry can host idle-postpone +
  restart-restore without an import cycle with ext-task (ticket 03's
  first investigation step).
- Live-TUI validation of the ask-user modal and composite widget after
  tickets 02/03 — the review was code-level; no live smoke has run.
- `/agents` definition-management parity: intentionally NOT charted
  (same call as tui-cc-parity's fog); revisit on user ask.
- CC's per-turn "X% context used" reminder injection: needs an SDK hook
  power-tool may not have; treat as a documented divergence unless a seam
  is found (relates to ticket 12).

## Cross-effort links

Builds-on: `2026-08-23-subagent-cc-parity-2` — its spec.md is the standing
subagent parity ledger; this effort's spec.md extends the ledger practice
to the task/power-tool domains (D5) and inherits its D8 in-PR update rule.
Builds-on: `2026-08-25-subagent-tui-cc-parity` — its D1 (parity is SHAPE +
VOCABULARY, s2 data stays) is the doctrine this effort applies to the
task/diagnostic surfaces.
Shares-decision-with: `2026-08-16-power-browser-tool` — ticket 13 extends
its surfaces (find/dialog/network); cite its ADRs before touching the
browser tool.
Shares-decision-with: `2026-08-15-subagent-dynamic-budgets` — ticket 03's
consolidation must not disturb its budget-tag rendering on the loop-adjacent
surfaces.
