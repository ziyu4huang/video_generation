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

## Verified mechanics addendum (2026-08-18, full forensics)

- The loop driver appends a FRESH goal-state snapshot (status: active) at every
  continuation boundary — a surgically appended complete entry is superseded
  within the same turn; journal-last-word protection fails while the loop lives.
- Full ~/.pi audit: goal id lives in exactly 9 files (1 session journal + 8
  subagent-run records = inert text mentions, not state). settings.json carries
  no goal state. pi is single-process per session (turn executor and
  continuation driver share one Bun event loop; no killable driver exists).
- Therefore: the ONLY restart-safe stop is exiting to a FRESH session (new
  journal, no harness-side goal store). Resuming the looping session would
  resurrect the goal from its last active entry.
- Fix implications tracked in issue #1616 (5 comments): in-driver per-iteration
  persisted-status re-read that defers to explicit completion records;
  goal_complete must ship with goal mode; toggle must write state immediately.

## RESOLUTION (2026-08-18)

- Repo-side mitigation LANDED: no-progress tripwire — 3 consecutive zero-tool-call
  continuations auto-pause the goal (PR #1625, squash 3b0e0860, 18/18 gates).
- Root cause definitive: goal_complete registers unconditionally
  (pi-agent-ext-task src/goal/goal.ts:77-79) but carries gating: { core: true }
  (goal-complete-tool.ts:84-85) — the harness curates core-gated tools per
  session and omitted it. Full chain on issue #1616 (9 comments).
- Candidate skill goal-loop-hygiene: SUPERSEDED — do not promote. The landed
  tripwire automates what it would teach; promoting now fails the need-gate.
- Default continuation budget LANDED: goals without --tokens now get a conservative 500k-token default (PR pending; see issue #1616).
- Remaining work is harness-side (ship core-gated goal_complete with goal mode,
  heartbeat availability check) — tracked on #1616.
- Live-loop stop remains: /goal pause or exit to a fresh session (restart-safe).
