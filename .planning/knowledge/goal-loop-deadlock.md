# Knowledge candidate: goal-loop deadlock when completion tool is unloaded

- **Trigger/symptom**: goal-mode auto-continuation keeps firing after the goal is
  verifiably complete; no `goal_complete` tool exists in the session toolset.
- **Lesson**: goal state lives in the session transcript; the only sanctioned
  stop paths are the in-session `goal_complete` tool (pi-agent-ext-task
  src/goal/goal-complete-tool.ts) or the user's `/goal` toggle. No CLI or
  external path exists (pi CLI commands/registry.ts has no goal command).
- **Proposed procedure (candidate skill: goal-loop-hygiene)**:
  1. On goal activation, if `goal_complete` is not in the session toolset, warn
     immediately: loop will be manually-stoppable only.
  2. Verify-then-rest pattern: on each continuation of an already-verified
     goal, run one cheap read-only durability check (ancestor SHAs + proof
     greps), report, and take no new scope.
  3. Never hand-edit the session transcript to force completion.
- **Fix candidates**: activation-time tool check (warn); or a
  `pi agent sessions`-adjacent goal command for out-of-session completion.
- **Evidence**: session of 2026-08-17/18, goal 5464ff67 (develop-pipeline
  effort, 8 merged PRs #1574-#1589, complete + verified); loop continued 6+
  times post-verification; probes documented in session transcript.
- **Candidate skill-name**: goal-loop-hygiene
