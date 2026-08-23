---
name: executing-plans
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
---

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Note:** Tell your human partner that Superpowers works much better with access to subagents (Claude Code, Codex CLI, Codex App, Copilot CLI, and Gemini CLI all qualify; see the per-platform tool refs in `../using-superpowers/references/`). If subagents are available, use superpowers:subagent-driven-development instead of this skill.

## Entry criteria

- Every task in the plan carries Run:/Expected: verification steps; a task without them goes back to writing-plans, never executed on trust.

## The Process

### Step 1: Load and Review Plan
1. Ensure an isolated workspace: use superpowers:using-git-worktrees to create one or verify the existing one
2. Read plan file
3. Review critically - identify any questions or concerns about the plan
4. If concerns: Raise them with your human partner before starting
5. **Ticket-order checkpoint** — if the plan came from an effort ticket queue (`.planning/<effort>/tickets/` + task_plan.md phases): present the execution order — the map's `**Execution order:**` line when a choice was already made, else the ticket-number order (to-tickets numbers blockers-first; the seed's phase order when a task_plan.md exists) — and ask confirm-or-rechoose before creating todos. A single open ticket, or a queue fully forced by `blocking:` edges, is a one-line confirm, not a full prompt. After confirmation, record the chosen order — the confirmed suggested order OR a re-chosen one — as the map's `Execution order` line the same session: the choice is the durable record, not only the deviations.
6. If no concerns and the order is confirmed: Create todos for the plan items and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. Mark as completed

### Step 3: Complete Development

After all tasks complete and verified:
- **Queue boundary (effort ticket queues only)** — if this plan was one ticket of a multi-ticket effort, write the successor next-goal file BEFORE closing out (devops `self-reflect-next-goal` strict v2 WRITE): `Immediate steps` = the next ticket in the chosen `Execution order`, `Done when` = its acceptance, `Ranked next goals` = the remaining queue + effort close-out. Validate + re-point `output/LATEST-next-goal.md`. This is the loop's carry — the file names the queue head even when the session stops here.
- **Continue or stop** — if the session is still fresh (smart-zone margin remaining) proceed to the next queue head in this same session (repeat the ticket-order line only when the next ticket's order was not user-chosen); if not, stop at the boundary — the successor file is the "hands on next goal" trigger.
- **Queue drained** — when no ticket remains in the chosen order, the successor's head = effort close-out (`map.md` status: complete), loop ends. Never write a self-perpetuating next goal.
- Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- **REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch
- Follow that skill to verify tests, present options, execute choice

## Dispatch ledger

The SDD progress.md carries one line per dispatched child:

```
[<task>] child(<tokenBudget>k/<maxTurns>t) -> done|died|janitored @<commit-sha>
```

Baseline from the 2026-08-16 effort: tokenBudget 150-260k, maxTurns 6-14, retryOnTransient false. Janitor recovery for died children: status -> gate -> check boxes -> commit green work (check git log before redispatching — budget-dead children still commit completed work).
Sizing + verbatim-apply + janitor rules: superpowers:dispatch-recovery (single source).

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent
