# spec — s2-agent vs Claude Code: task cockpit + diagnostics (ext-task, ext-power-tool)

The parity ledger for the task/power-tool domains. Companion to the standing
subagent ledger (`.planning/2026-08-23-subagent-cc-parity-2/spec.md`), which
stays authoritative for subagents/workflows/cron/budgets. Sources: 4-way
parallel code review 2026-08-25 (this machine), anchor claims re-verified
first-hand; CC semantics observed in Claude Code 2026-08-25.

## 1. Alignment table

CC feature | s2 equivalent (ext-task / power-tool) | status | ticket
--- | --- |---|---|
TaskCreate/TaskUpdate/TaskList/TaskGet (4 focused tools) | ONE family: ext-subagent `task_create/get/list/update` over TeamTaskStore, core-gated in every session shape; ext-task's `todo` mega-tool retired to a TUI face (D7) | aligned (t02) | 02 ✅
task dependencies (addBlocks/addBlockedBy symmetric, blocked-until-resolved) | symmetric both sides + cycle-checked + atomic (TeamTaskStore); `effectiveBlockedBy` selector clears completed deps in task_list AND the TUI widget | aligned (t02) | 02 ✅
workflow discipline in tool text (in_progress-before-start, completed-only-when-done, blocked→new task) | three rules in task_create/task_update descriptions (snippet stealth-trimmed by design) | aligned (t02) | 02 ✅
`activeForm` in live spinner | present-continuous label renders in the composite widget's in_progress line + task_list lines (no spinner concept in the TUI; field description no longer overpromises) | aligned-shape (t02) | 02 ✅
AskUserQuestion (1-4 questions, header ≤12, 2-4 options, multiSelect, preview, recommended-first, Other) | `ask_user_question` — all present, schema+runtime enforced | aligned | — |
AskUserQuestion annotations (notes + preview selection returned to model) | notes appended to model content (`— note: …`) since PR #2030 | aligned | — |
"only ask when genuinely the user's decision" guidance | one-line guard in the description (t02) + host/validation errors flagged isError, never `cancelled:true` | aligned (t02) | 02 ✅ |
EnterPlanMode/ExitPlanMode (approval-gated, read-only planning) | plan approval gate (t01): `/goal` start/resume prompt + `/goal approve`; contract-fingerprinted approval; write/edit blocked while unapproved; goal_complete blocks "not approved" ahead of incomplete-phases | aligned (t01) | 01 ✅
auditor read-only enforcement | `AUDITOR_TOOLS` = read/grep/find/ls (bash removed), test-pinned; prompt updated to match | aligned (t01) | 01 ✅
`/loop` + ScheduleWakeup (one mechanism, dynamic pacing) | TWO `/loop`s (ext-task fixed-cadence LoopScheduler; ext-ultracode WakeupRegistry), `/loop:2` redirect | divergent | 03
surface repeated failure to the model (strategy change) | pathology warnings status-line-only by design (opt-in injection charted) | divergent → opt-in parity | 04
`/cost` + `/status` (cumulative spend, duration, turns) | absent (turn counter exists internally) | gap | 05
`/context` (per-category breakdown, % of window, free space) | inspect_context: % of current usage, no free-space row, opaque residual bucket | partial | 12
auto micro-compaction of stale tool outputs | absent repo-wide (full compaction is par via ext-compact) | gap (owned by ext-compact, not this effort) | — |
playwright MCP browser_find / dialog / network surfaces | browser tool: none of the three (snapshot-first, compression, refuse-not-truncate are ahead of CC) | partial | 13
error results flagged isError | task_* error envelopes + ask-user host/validation errors return `isError:true` (t02); a genuine user Esc-cancel stays non-error | aligned (t02) | 02 ✅

## 2. Deliberate divergences (keep, with rationale)

- **One shared board, not per-agent scratchpads (t02/D7)** — the surviving
  family is ext-subagent's `task_create/get/list/update` over the TeamTaskStore
  process singleton: the parent, in-process children, and workflow agents share
  ONE board (CC shares its task list across agents the same way). ext-task's
  per-session todo buckets died with the mega-tool — a child writing the board
  is coordination, not the ticket-#16 contamination (that hazard was scoped to
  the retired private-scratchpad design). The TUI face (/todos + composite
  widget) renders the same board through `board-view.ts`.
- **Flat `type:"object"` schema roots per tool** — OpenAI-compatible providers
  (z.ai GLM) 400 on `anyOf` roots; the four task_* tools each keep a flat
  object root (leaf-level unions are safe). Inherited from the retired `todo`
  mega-tool constraint; now satisfied trivially per-tool.
- **Stealth-trimmed promptSnippet on the task family** — the four tools carry
  no per-turn snippet (pinned in ext-subagent tests/task-tools.test.ts);
  discipline text lives in the DESCRIPTIONs.
- **Pathology non-invasive default** — status-line-only warnings are the
  documented contract (CONTEXT.md); model-visibility is opt-in env (D2).
- **Session-only board** — never replayed/persisted; reset on session_start,
  dropped on session_shutdown, permanent tracking lives in
  wayfind/`.planning/` (CONTEXT.md). Unchanged by ticket 02.
- **goal machinery has no CC analog and stays** — auditor, quota-retry,
  heartbeat supervision, length-continue are s2-only advantages; ticket 01/11
  tune edges (bash grant, reviewer default), never remove the machinery.
- **Read-only planning blocks write/edit only, not bash (t01)** — the
  tool_call seam is toolName-only (no args to inspect), so a blanket bash
  block would break read-only greps. CC's plan mode inspects bash commands;
  s2 cannot at this seam. bash writes during unapproved planning remain
  possible (prompt-discipline only) — same posture the auditor had before
  t01 dropped its bash grant.
- **Plan approval is session-scoped, not persisted (t01)** — CC's plan-mode
  approval is also per-session; a new session re-prompts. The approval
  record lives in `plan/approval.ts`'s module map, reset per process.

## 3. s2-only advantages (no CC counterpart — do not remove)

- Isolated second-model auditor with must-call-read-tool floor + stall abort;
  quota-retry with Retry-After parsing; heartbeat wedge supervision with HITL
  exemption; length-continue recovery.
- The pathology engine itself: pure detectors over a typed input,
  zero-storage historical replay, volatility-relative thresholds with the
  judged-pair exclusion, occurrence-rate denominator discipline.
- Browser token economy: aria compression, prune modes, refuse-not-truncate
  limits, per-(page,scope) diff store, audit trail with screenshots.
- Composite below-editor widget with deterministic section ordering (the todo
  section now renders the shared board — t02); CC has no below-editor
  cockpit at all.
- ask-user: Esc-destination state machine, external webui answer channel +
  tombstone events, RPC dialog-walker fallback, identity-en i18n design.

## 4. Maintenance rule

Every parity ticket updates §1/§2/§3 in its own PR (inherited from the
subagent ledger's D8). A divergence introduced anywhere in these domains must
be recorded here in the same PR that introduces it.

## 5. CC semantics references (observed 2026-08-25, first-hand)

- Task tools: TaskCreate(subject, description, activeForm, metadata) /
  TaskUpdate(status pending→in_progress→completed|deleted, addBlocks,
  addBlockedBy, owner) / TaskList (summary + blocked) / TaskGet (detail).
- AskUserQuestion: questions[1-4]{question, header≤12, options[2-4]{label
  1-5 words, description, preview?}, multiSelect}; recommended = first option
  + "(Recommended)" label suffix; "Other" auto-provided; answers keyed by
  question text with annotations (notes, preview selections).
- Plan mode: EnterPlanMode (user approves entry) → read-only exploration →
  plan file → ExitPlanMode (user approves plan) → implementation.
- Scheduling: ScheduleWakeup (60–3600s clamp, reason, stop) + CronCreate
  (5-field, 7-day expiry, durable/session) — already par via ultracode.
- Context: auto micro/full compaction invisible to the user; /context shows
  per-category share of the window + free space; /cost shows cumulative
  spend + duration + turns.
