---
name: subagent-driven-development
description: Use when executing implementation plans with independent tasks in the current session
---

# Subagent-Driven Development

Execute a plan by dispatching a fresh implementer subagent per task, a task
review (spec compliance + code quality) after each, and a broad whole-branch
review at the end.

**Why subagents:** delegated tasks get isolated context — you construct
exactly what the child needs (it never inherits your session history), and
your own context stays clean for coordination.

**Core principle:** fresh subagent per task + task review + broad final review
= high quality, fast iteration.

**Narration:** between tool calls, at most one short line — the ledger and the
tool results carry the record.

**Continuous execution:** never pause between tasks. Stop only on BLOCKED you
cannot resolve, ambiguity that genuinely prevents progress, or completion.
"Should I continue?" prompts waste your partner's time.

## When to Use

Have an implementation plan + tasks mostly independent + staying in this
session → this skill. Tightly coupled tasks → manual execution or brainstorm
first. Parallel session instead → superpowers:executing-plans. vs
executing-plans: same session, fresh subagent per task, review after each task,
no human-in-loop between tasks.

## The Process

Setup → per-task loop (dispatch → handle report → review → fix loop →
complete) → final whole-branch review → finish.

1. **Setup**: isolated worktree (superpowers:using-git-worktrees; never
   implement on main without explicit consent); ledger check (below); read
   plan once; todos per task; pre-flight conflict scan (below).
2. **Per task**: dispatch implementer → handle report → task review → fix loop
   if triggered → ledger completion line.
3. **After all tasks**: final code review (most capable model) → one fix wave
   → finish.

## Setup & the Ledger

Conversation memory does not survive compaction — controllers that lost their
place have re-dispatched entire completed task sequences (the most expensive
failure observed). Track progress in a ledger file.

- Resolve the workspace: run this skill's `scripts/sdd-workspace PLAN_FILE` —
  prints the plan's git-ignored directory; every artifact for THIS plan lives
  there: ledger, briefs, reports, review packages. Another plan's directory is
  never yours to read or write.
- Ledger at `<workspace>/progress.md`. First line names the plan file. `Task
  <N>: complete` lines are DONE — never re-dispatch; resume at the first task
  without one. A task whose last line is a fix round is mid-loop — resume at
  the next round. A ledger naming a different plan (or a stray at a legacy
  flat path) is another plan's — leave it in place, start your own fresh.
- Create the ledger as `# SDD ledger — plan: <plan file path>`.
- The ledger is your recovery map: commits it names exist in git even when
  your context doesn't remember creating them. After compaction, trust the
  ledger and `git log` over your own recollection.
- `git clean -fdx` destroys the workspace (git-ignored scratch) — recover
  from `git log`.

**Pre-flight conflict scan** (before Task 1): scan the plan once for tasks
contradicting each other / the Global Constraints, or mandating what the
review rubric treats as a defect (assert-nothing tests, verbatim duplication).
Batch EVERYTHING into one question to your human partner — each finding beside
the plan text that mandates it, asking which governs — before execution
starts. Clean scan → proceed without comment.

## Model Selection

Least powerful model that handles the role; ALWAYS specify explicitly (omitted
= inherits your session model, often the most expensive — silently defeats
this section).

- Mechanical tasks (isolated, clear spec, 1-2 files; or plan text contains the
  complete code = transcription+testing): cheapest tier.
- Integration/judgment (multi-file coordination, prose-described work):
  standard/mid tier. Mid tier is the floor for reviewers and prose-brief
  implementers.
- Architecture/design + the final whole-branch review: most capable available.
- Reviews: judgment scaled to the diff's size/risk; scoped re-reviews of small
  fixes: cheap-to-mid.
- Fix-loop rounds 4-5: at least one tier above the stuck implementer.
- **Turn count beats token price**: cheap models routinely take 2-3× the turns
  on multi-step work, costing more overall.

## The Task Loop

Everything pasted into a dispatch — and everything a child prints back — stays
resident in your context all session. Hand artifacts over as files.

### 1. Dispatch the implementer

Record BASE (`git rev-parse HEAD`) before dispatching — review packages and
fix diffs need it.

- **Brief**: run `scripts/task-brief PLAN_FILE N` (extracts task text to a
  unique file, prints path). The brief is the single source of requirements;
  exact values (numbers, signatures, test cases) live ONLY there. Dispatch
  contains: (1) one line of project context; (2) brief path — "read first;
  your requirements, verbatim values"; (3) interfaces/decisions from earlier
  tasks the brief can't know; (4) your resolution of noticed ambiguities;
  (5) report path + report contract. Never make a child read the whole plan.
- **Report file**: named after the brief (`task-N-brief.md` →
  `task-N-report.md`). Child writes the full report there; returns only
  status, commits, one-line test summary, concerns.
- One task per dispatch — no accumulated prior-task summaries ("state after
  Tasks 1-3"; a real dispatch hit 42k chars, 99% pasted history). A fresh
  child needs its task, the interfaces it touches, global constraints.
  Nothing else.
- Carry pointers to parked findings in the area this task touches.
- Record the implementer's agent identity (rounds 1-3 resume it).
- Never dispatch multiple implementers in parallel (conflicts).

Template: [implementer-prompt.md](implementer-prompt.md)

### 2. Handle the report

- **DONE** → review package (`scripts/review-package PLAN_FILE BASE HEAD`;
  BASE = pre-dispatch commit, never `HEAD~1` — it truncates multi-commit
  tasks) → dispatch task reviewer with the printed path.
- **DONE_WITH_CONCERNS** → read concerns; correctness/scope concerns before
  review; observations noted, proceed.
- **NEEDS_CONTEXT** → provide the missing context, re-dispatch.
- **BLOCKED** → context problem: add context, same model; needs reasoning:
  more capable model; too large: split; plan wrong: escalate. Never force the
  same model to retry unchanged — if it says stuck, something changes.
- Mid-task questions: answer completely; don't rush into implementation.

### 3. Review the task

Per-task reviews are task-scoped gates (the broad review happens once, at the
end). Never skip; never accept a report missing either verdict — spec
compliance AND quality are both required; self-review never replaces the task
review.

- Diff as a file: `scripts/review-package PLAN_FILE BASE HEAD`, pass the
  printed path (or, without bash: `git log --oneline`, `git diff --stat`,
  `git diff -U10` for the range, redirected to one file). Output never enters
  controller context. Never dispatch a reviewer without a diff file.
- Reviewer inputs: brief path + report path + review package + the binding
  global constraints, copied VERBATIM from the plan/spec (exact values,
  formats, relationships — "same layout as X"). The template carries process
  rules; the constraints block is what THIS spec demands.
- No open-ended directives ("check all uses") without a concrete task-specific
  reason. Don't re-run tests the implementer already ran (the report carries
  evidence). Never pre-judge: if your prompt contains "do not flag", "at most
  Minor", "the plan chose" — stop; let the reviewer raise it, adjudicate in
  the loop.
- "⚠️ Cannot verify from diff" items don't block the review, but YOU resolve
  each before marking complete (you hold the plan context); confirmed real =
  failed spec review, enters the fix loop.

Template: [task-reviewer-prompt.md](task-reviewer-prompt.md)

### 4. The fix loop

Triggers on: spec ❌, any Critical/Important finding, or a confirmed ⚠️ gap.
Two immediate exits:

- **Minor findings** never enter the loop — ledger line `Task <N>: minor
  (deferred): <one-liner>`; point the final review at that list for triage.
- **Plan-mandated findings** (conflict with plan text) are the human's
  decision: finding + plan text, ask which governs. Never dismiss, never fix
  against the plan unasked.

Everything else: one fix dispatch + one scoped re-review per round; five
rounds max.

- **Rounds 1-3: resume the original implementer** (context intact) with
  findings verbatim. If your harness can't message a live child: fresh
  implementer with brief path + report path + findings (the report file is
  the persistent memory either way).
- **Rounds 4-5: fresh implementer, one tier up**, with brief + report paths +
  findings + "a prior implementer attempted N times; you own it now; read the
  report for what was tried." Three survived resumes = it can't see its own
  problem.
- **Every round**: fix + re-run the covering tests (named in the fix message)
  + fix report APPENDED to the same report file (must contain tests, command,
  output) → only then re-dispatch the re-review.
- **Scoped re-review**: `scripts/review-package PLAN_FILE FIX_BASE HEAD`
  (FIX_BASE = head the previous review saw) + [re-review-prompt.md](re-review-prompt.md)
  with findings + brief + report + diff path. Verdicts per finding ADDRESSED /
  NOT ADDRESSED; flags new breakage in the fix diff only. New Critical/
  Important in the fix diff joins the open list; out-of-scope observations →
  ledger as deferred minors, never extend the loop.
- **Ledger every round**: `Task <N>: fix round <R>/5 (<X> addressed, <Y> open
  — <one-liners>; commits <a7>..<b7>)`.
- **Never fix findings yourself** — controller fixes pollute context and skip
  review.
- **The breaker** (round 5 still open): stop dispatching; adjudicate each
  finding — reviewer wrong/contestable → park with ruling; real-but-not-
  load-bearing → park, real and deferred; **real and load-bearing** (a later
  task builds on it / plan defect) → STOP, `Task <N>: BLOCKED — <reason>`,
  report to your human partner with finding + plan text + fix history.
  Adjudicate ONLY at the cap — early adjudication is pre-judging with another
  name; every ruling is a ledger entry; silent discards forbidden.

### 5. Complete the task

Clean review (or all open parked-with-ruling at the cap): append `Task <N>:
complete (commits <base7>..<head7>, review clean)` — or `, <K> parked` after a
tripped breaker — mark the todo, move on. Never advance while Critical/
Important findings are neither fixed nor parked-with-ruling at the cap.

## Final Review

- Package: `scripts/review-package PLAN_FILE MERGE_BASE HEAD` (MERGE_BASE =
  `git merge-base main HEAD`); the final reviewer reads one file instead of
  re-deriving the branch diff.
- Dispatch on the most capable available model, via
  superpowers:requesting-code-review's
  [code-reviewer.md](../requesting-code-review/code-reviewer.md); point it at
  the ledger's deferred-minor and parked lines for triage.
- Findings → **ONE fix dispatch** with the complete findings list (per-finding
  fixers rebuild context and re-run suites each; a real session's per-finding
  wave cost more than all its tasks combined) → exactly ONE scoped re-review
  (`review-package PLAN_FILE FIX_BASE HEAD` + re-review-prompt) → adjudicate
  residuals like the breaker. No second fix wave; load-bearing residuals
  surface to your human partner when finishing-a-development-branch presents
  options.

## Finish

Final review clean + fixes merged → delete THIS plan's workspace (`rm -rf
<workspace>`); git history is the record. Sibling directories belong to other
plans; leave them alone. Then superpowers:finishing-a-development-branch.

**Ticket-queue linkage (effort tickets only):** when the plan was seeded from a
`.planning/<effort>/tickets/` queue and tickets remain in the chosen `Execution order`, the
close-out's next-goal file (devops `self-reflect-next-goal`, strict v2) carries the queue —
`Immediate steps` = the next ticket, `Ranked next goals` = the remaining queue + effort
close-out. The ledger in `<workspace>/progress.md` stays the intra-session recovery
(survives compaction within the plan); the next-goal file is the inter-session recovery when
the queue outlives this session. Keep the "never pause between tasks" principle intact —
within one plan, no new pauses.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Close enough on spec" | Reviewer found gaps = not done. Fix or cap-and-adjudicate — the only exits. |
| "I'll fix it myself, dispatching is overhead" | Controller fixes pollute context and skip review. Resume the implementer. |
| "One more round converges" | Past the cap, rounds don't converge — structural. Adjudicate and route. |
| "Reviewer finds something new anyway" | Scoped re-reviews verify fixes; new findings on untouched code → ledger, not loop. |
| "Finding is wrong, I'll drop it" | Adjudicate only at the cap; every ruling is a ledger entry. Silent discards forbidden. |
| "Fix was small, skip re-review" | Unreviewed fixes are how regressions land. |
| "Ledger is overhead" | The ledger survives compaction; without one, controllers re-dispatch completed sequences. |

## Example (condensed)

```
[Setup: worktree; sdd-workspace PLAN; no ledger → fresh; todos created]
Task 1: task-brief → dispatch implementer (brief+report paths+context)
  → DONE → review-package BASE HEAD → task reviewer: Spec ✅, quality approved
  → ledger: Task 1: complete (a1b2c3d..d4e5f6a, review clean)
Task 2: dispatch → reviewer: Spec ❌ missing progress reporting; Important: magic number
  → fix round 1: resume implementer with both findings → fix + covering tests re-run
    + fix report appended → scoped re-review: both ADDRESSED, no new breakage
  → ledger: fix round 1/5 (2 addressed, 0 open) + Task 2: complete
[All tasks → review-package MERGE_BASE HEAD → final reviewer (most capable)
  → one fix dispatch for findings → one scoped re-review → clean]
[Delete workspace → finishing-a-development-branch]
```
