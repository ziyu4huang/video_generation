---
effort: 2026-08-18-goal-loop-incident
created: 2026-08-18
last: 2026-08-18
status: complete
---

# Wayfinder map: goal-loop-incident (retro)

> Recorded complete post-hoc: this incident chain ran through in-session
> forensics + direct fixes, not the wayfind stages, before map discipline
> applied (same shape as the 2026-08-16-solution-extension-simplification retro).

## Destination
Convert the goal-5464ff67 unstoppable-continuation incident into durable,
tested protection and a complete root-cause record. Reached.

## Notes
- Incident: goal mode auto-continued ~12+ times after the goal was verifiably
  complete (9+ PRs merged); the session toolset omitted the goal_complete tool.
- Forensics (issue #1616, 9 comments): stop-triad verified (tool, toggle,
  persistence all fail while the loop is live); loop driver is memory-resident
  with the session store as recovery journal; single-process (no killable
  driver); root cause = gating: { core: true } on goal_complete
  (goal-complete-tool.ts:84-85) + harness curation omitting it.
- Fixes landed: no-progress tripwire (PR #1625, 3 zero-tool-call continuations
  auto-pause; scope-agnostic detection; 6 unit tests) — protects future sessions.
- Knowledge: goal-loop-deadlock.md (PR #1617/#1620, resolved by #1629);
  dispatch empirics census promoted to the dispatch-recovery skill (PR #1628,
  superpowers 14->15 skills); docs truth-synced (PR #1629).
- Repo hygiene: branch sweep via devops sweep-cli (merged-evidence only).
- Live-loop stop remains user-side: /goal pause or exit to a fresh session
  (restart-safe: journal last-entry-wins, no harness-side goal store).
- Addendum 2026-08-18 (post-close): two more guards landed after this map was
  written — default 500k-token continuation budget (PR #1634) and heartbeat
  persisted-status check (PR #1636). Repo-side ledger closed (issue #1616
  comment 11); the sole remaining item is harness-side core-gated
  goal_complete curation.
- Addendum 2 (2026-08-18, final ledger): the aftermath outgrew the incident.
  (a) clean main itself was red — pi-agent-ext-webui imported
  @earendil-works/pi-coding-agent undeclared (fixed, #1642); diagnosis
  blocked pushes, so main-health gained a temp-worktree fallback for this
  repo's all-detached mode (#1644). (b) that rescue exposed the 3-incident
  defect class (yaml #1589, lockfile #1591, webui #1642) — now guarded by
  the declared-imports audit gate (warn-only v1, #1647) with a zero
  baseline (#1649); blocking flip scheduled after soak week (issue #1645).
  (c) issue board triaged: #1435 closed verified-fixed; #1431 kept open
  with contained-not-fixed addendum. Total session ledger: 23 merged PRs
  (#1574-#1649), gate suite 17 -> 20, superpowers 14 -> 15 skills.

## Decisions so far
- Tripwire over tool unregistration changes: repo-side minimal guard; the
  registration itself is unconditional and correct (goal.ts:77-79).
- goal-loop-hygiene candidate superseded by the landed tripwire (do not promote).
- Remaining harness-side items (ship core-gated goal_complete with goal mode,
  default continuation budget, heartbeat availability check) stay on #1616.

## Not yet specified
<!-- none — closed -->

## Out of scope
<!-- none -->
