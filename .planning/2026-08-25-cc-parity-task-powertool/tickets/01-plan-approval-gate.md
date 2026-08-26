# Ticket 01 — Plan approval gate (ExitPlanMode-shaped)

Status: closed (2026-08-27; PR pending at write time — receipt below)

## Why

CC's plan mode is approval-gated: the user approves entering planning, the
model explores read-only, then approves the plan before implementation
starts. s2-agent's plan coordinator is a passive phase-counter — the only
gate is negative (`goal_complete` blocked while phases are incomplete). And
the closest thing to read-only enforcement, the goal auditor, grants `bash`
with only a prompt-level "Never modify files" (auditor.ts:185).

## Scope

1. **Approval surface**: when `/goal` starts with an active plan effort (or
   a new `/plan` entry command, whichever fits the coordinator's shape),
   render the plan's phase summary and ask approval via `ctx.ui.confirm`;
   record the approval in the coordinator state. Unapproved plan ⇒
   implementation tools stay ungated but `goal_complete` explains why it
   blocks (extend the existing negative gate, don't duplicate it).
2. **Re-approval on phase change**: entering each new phase of a multi-phase
   plan re-prompts only if the phase's Done-when contract changed — keep it
   cheap; do not prompt per turn.
3. **Auditor read-only grant**: drop `bash` from the auditor's tool list
   (auditor.ts:185) or replace with a no-write wrapper; the must-call-read-
   tool floor stays. Pin with a test asserting the granted tool list.
4. **Read-only planning option** (investigate first): whether pi's tool
   gating can block write tools while "planning" is active the same way
   hooks.ts blocks stale-goal tool calls (`before_agent_start`) — if yes,
   wire it behind the approval state; if the seam is awkward, record it as
   a divergence in spec.md §2 instead of forcing it.
5. Tests: approval state machine (approve/deny/re-prompt), gate block text,
   auditor tool-list pin.

Not in scope: wayfind's `__piPlan*` consumers (display-only, unchanged);
the coordinator's file-parsing behavior; ultracode's plan-approval protocol
envelope (child→parent, different surface).

## Done-when

- [ ] A plan effort cannot drive `goal_complete` to completion without a
      recorded user approval (manual TUI smoke receipt).
- [ ] Auditor cannot run bash (test-pinned grant list).
- [ ] Read-only-during-planning either wired or recorded as a deliberate
      divergence in spec.md §2 with the seam investigation noted.
- [ ] Canonical gates green; spec.md §1 plan-mode row updated; PR merged
      CLEAN via the devops chain.

## Receipt (2026-08-27)

- **`plan/approval.ts`** — pure, pi-import-free approval state machine:
  contract fingerprint = phase `id|title|stepCount` (progress NEVER
  invalidates; structure does); `planApprovalNeeded` / `shouldPromptForApproval`
  (once-per-contract-version prompt dedupe) / `recordPlanDecision`; per-cwd
  records; `__resetPlanApproval` test seam.
- **Gates**: `planningGateBlocking` (goal/internals.ts) now blocks
  unapproved-incomplete FIRST ("not approved yet — /goal approve"), falling
  through to the pre-existing incomplete-phases reason once approved — the
  negative gate extended, not duplicated. Read-only planning wired on the
  tool_call seam (hooks.ts): `write`/`edit` blocked while a goal is active
  against an unapproved plan — the same seam the stale-goal blocker uses, so
  scope item 4 is WIRED, not a divergence. bash stays allowed (toolName-only
  seam, no args to inspect) — recorded in spec §2.
- **Entry points**: `/goal` start + `/goal resume` prompt via
  `ctx.ui.confirm` (lifecycle.ts); new `/goal approve` subcommand — explicit,
  bypasses the automatic prompt dedupe (smoke-found regression: a denied
  contract must re-prompt on the explicit command; unit-pinned).
  Re-approval on contract change: agent_end turn-boundary re-prompt, once per
  edited contract version, never per turn.
- **Auditor grant**: `AUDITOR_TOOLS = ["read","grep","find","ls"]` exported,
  `bash` removed from the session factory, the prompt line, AND the
  must-call-read-tool floor; test-pinned in auditor.test.ts.
- **Smoke receipt** (manual, real state machine in one process, human answers
  piped): /goal start → deny → goal_complete rejected "not approved" →
  /goal approve → approve → goal_complete rejected "incomplete phases" →
  plan completed + refreshPlan → goal_complete accepted (terminate:true).
  Interactive TUI dialog rendering itself not smoked (same `ctx.ui.confirm`
  surface the startGoal replace-dialog and Reviewer proposals already render
  in the TUI); gap noted, not blocking.
- **Tests**: approval.test.ts (state machine, 10 cases), goal.test.ts
  (approval-first gate reasons, goal_complete deny→approve ladder, read-only
  tool_call block/release, /goal approve deny-reprompt regression), commands
  + auditor pins. ext-task 913 pass / 0 fail; tsc --noEmit clean.
