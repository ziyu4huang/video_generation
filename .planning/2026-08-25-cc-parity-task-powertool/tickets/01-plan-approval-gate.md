# Ticket 01 — Plan approval gate (ExitPlanMode-shaped)

Status: pending

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
