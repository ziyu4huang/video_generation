# Knowledge candidate: subagent dispatch empirics (long multi-agent sessions)

- **Trigger/symptom**: orchestrating 20-30+ write-capable subagent dispatches in
  the video_generation multi-session worktree.
- **Empirics** (~/.pi/subagents/runs, 200 parsed records, 2026-08-16..18 session
  chain, PRs #1574-#1625):
  - 166 done / 20 turns-capped / 14 budget-dead = **17% death rate; 0
    unrecoverable failures**. Child death at tokenBudget or maxTurns is routine,
    not exceptional — plan every multi-step mission for it.
  - Dying children report progress optimistically ("src changes DONE") that the
    tree contradicts; last words are NOT evidence. A 4-child fix attempt
    produced zero code despite two "done" claims — always verify via
    git status/diff/log before redispatching.
  - Janitor pattern (status -> gates -> commit green work -> report) recovered
    nearly every death cheaply; budget-dead children still commit completed
    work, so check the git log BEFORE redispatching.
  - Verbatim-apply dispatches (parent authors exact file content + command
    sequence; child only executes) succeed at far higher rates than
    design-in-child dispatches (parent research -> verbatim brief -> apply).
  - One mega bash block in turn 1 beats exploratory reads: children that start
    reading before acting burn turns on discovery and die mid-read.
  - Run records do NOT persist tokenUsage — per-child cost must be tracked by
    the orchestrator (the dispatch-ledger format exists for exactly this).
  - commit-scope violation warnings are noise in this multi-session worktree
    (they flag intended files or ancestor sync commits on nearly every commit).
- **Proposed procedure** (candidate skill: dispatch-recovery): janitor-first
  recovery; verify-by-git trust model; verbatim-apply brief template;
  single-block turn-1 budgeting; orchestrator-side ledger of budgets/outcomes.
- **Evidence**: goal 5464ff67 session chain; run-record census 2026-08-18.
- **Candidate skill-name**: dispatch-recovery
