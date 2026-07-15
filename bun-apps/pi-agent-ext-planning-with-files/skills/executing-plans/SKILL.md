---
name: executing-plans
description: Use when you have a written implementation plan to execute across tasks, with review checkpoints. Covers execution DISCIPLINE (critical plan review, per-task rhythm, exception handling, when to stop and ask, completion report). The progress tracking, hooks, and nags are owned by planning-with-files; this skill is about how to execute the plan well.
---

# Executing Plans

## Overview

Load the plan, review it critically, execute every task, then report.

> **Scope boundary:** planning-with-files owns *tracking* execution — `progress.md`,
> the "Task incomplete (N/M)" status-bar nags, and the `/plan-execute` gate that
> activates hooks. This skill owns the *discipline* of moving through the tasks well.
> The two are complementary layers, not substitutes.

**Announce at the start:** "I am using the executing-plans skill to implement this plan."

**Subagents:** if the tasks are independent and the platform supports subagents, quality
improves noticeably when each task runs in an isolated subagent (via the `subagent` or
`workflow` tools) with a review between tasks. If tasks are tightly coupled, execute
inline with checkpoints instead.

## Process

### Step 1: load and review the plan

1. Read the plan file.
2. **Review it critically** — identify any problems or concerns.
3. If there are concerns: raise them with your partner before starting.
4. If not: set up the `todo` tool and continue.

**What to check on review:**
- Missing dependencies between steps? (A depends on B, but B comes after A)
- Are verification conditions explicit? ("confirm it works" doesn't count;
  "`bun test` all green" does)
- Hidden environment assumptions? (Node version, a running service, an API key)

**Review example:**
```
Plan: .planning/<slug>/task_plan.md
Tasks: 5

Review findings:
- Task 3 (DB migration) after Task 2 (data model) — order correct ✓
- Task 4 verification says "confirm feature works" → needs sharpening:
  which test command specifically?
- Plan doesn't state the Python venv → confirm

Raise with partner:
"Plan is executable. Two issues: (1) Task 4 verification is vague, suggest
'pytest tests/test_api.py all green'; (2) confirm the venv."
```

### Step 2: execute each task

For every task:

1. **Mark in-progress** — update the `todo` tool
2. **Understand the goal** — re-read the task description, nail the completion criteria
3. **Implement** — follow the plan's steps exactly (the plan already has small steps)
4. **Verify** — run the test or check the plan specifies
5. **Commit** — one commit per task; the message references the task number
6. **Mark done** — update the `todo` tool **and** set the phase `**Status:** complete` in `task_plan.md`, in the **same step**. They don't auto-sync: the Todos panel reads the `todo` tool while the plan hooks read the markdown — updating only one leaves the other stale (the "Todos still shows incomplete after a merged PR" footgun).

**Per-task rhythm:**
```
--- Task 2/5: add input validation ---
[mark in-progress]

Goal: add input validation to /api/users
Done when: all validation tests pass, invalid input returns 400

[implement]
- add validateUser() middleware
- write 3 rules (email format, password strength, username length)

[verify]
$ bun test --grep validation
  ✓ rejects invalid email (12ms)
  ✓ rejects weak password (8ms)
  ✓ rejects too-long username (5ms)
  3 passing

[commit]
$ git add src/middleware/validate.ts tests/validation.test.ts
$ git commit -m "feat: add user input validation (task 2/5)"

[mark done]
--- Task 2/5 done ---
```

**Continuous self-check:** am I still on course? Have I drifted from the plan? If an
earlier task's implementation turns out flawed, fix it before continuing — don't carry
a known problem forward.

### Step 3: handle common exceptions

**Test failure:**
1. Read the error, locate the failure cause.
2. Distinguish: implementation bug? test itself wrong? plan description wrong?
3. Implementation bug → fix and re-run.
4. Test wrong → fix the test, explain to your partner.
5. Plan wrong → stop, report to your partner and propose a correction.

(For anything beyond a trivial fix, switch to the `systematic-debugging` skill —
root-cause first, never symptom-patch.)

**Missing dependency:**
```
Task 3 needs a Redis connection, but the plan never sets Redis up.
→ stop
→ report: "Task 3 needs Redis, no config step in the plan.
   Suggest inserting 'configure Redis' before Task 3."
```

**Unclear instruction:**
- Don't guess intent. Don't "reasonably infer".
- List your understanding and your confusion, ask your partner to clarify.
- Wait for the reply before continuing.

### Step 4: finish development

Once all tasks are done and verified, follow the repo's branch-finishing workflow (see
CLAUDE.md: run `bun run format` + `bun run check`, open the PR, poll `gh pr checks` to
green, `gh pr merge --squash --delete-branch`, then detach + `git fetch --prune` +
`./scripts/stale-branches.sh`).

**Completion report template:**
```
## Execution report

**Plan:** .planning/<slug>/task_plan.md
**Branch:** feat/<name>
**Tasks:** 5/5 complete

### Completed tasks
1. ✅ scaffold project structure
2. ✅ add input validation
3. ✅ add DB migration
4. ✅ implement API endpoint
5. ✅ add integration tests

### Verification
- unit tests: 23/23 pass
- integration tests: 8/8 pass
- lint: 0 warnings

### Deviations from plan
- Task 3: Redis config moved from env to config.yaml (partner-approved)

### Next
finish the branch per CLAUDE.md (format → PR → squash-merge → cleanup)
```

## When to stop and ask

**Stop immediately when:**
- blocked (missing dependency, failing test, unclear instruction)
- the plan has a serious flaw that prevents starting
- you don't understand an instruction
- verification fails repeatedly (same test fails 2+ times — switch to
  `systematic-debugging`)

**When unsure, ask. Don't guess.**

## When to go back a step

**Back to review (Step 1) when:**
- your partner updated the plan based on your feedback
- the fundamental approach needs rethinking

**Don't force through a blocker** — stop and ask.

## Notes

- Critically review the plan first.
- Follow the plan's steps exactly.
- Don't skip verification.
- One commit per task; the message references the task number.
- Stop at blockers; don't guess.
- Never start implementation on `main`/`master` without explicit user consent.
