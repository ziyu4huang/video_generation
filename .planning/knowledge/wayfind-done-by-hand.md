# Skill candidate: wayfind-done-by-hand

**trigger/symptom**: A subagent session (no /wayfind slash commands) must close a completed wayfind effort — status/frontier verified terminal, but the ceremony command is unreachable; or /wayfind done exists but its mechanics are unknown to the session.

**lesson**: /wayfind done is replicable exactly by hand; every step is a deterministic fs operation with precise formats. The one non-obvious trap: the next-goal note must be written INSIDE the effort dir (it rides the rename into .planning/done/ and is git-tracked), NOT repo-root output/ (gitignored — the anchored /output/ rule only ignores root). Second trap: hand-written tickets must be parser-normalized (fenced front-matter, bare-number blocking) before the frontier check passes.

**proposed procedure**:
1. Verify terminal state with the real parser: readMap from bun-apps/pi-agent-ext-wayfind/src — frontier must be [] and every ticket status:closed.
2. Write output/next-goal-YYYYMMDD_HHMMSS.md INSIDE .planning/<effort>/ (date +%Y%m%d_%H%M%S): title "# Goal completed: <destination>", Effort line (mention it will live under done/), Self-reflection (false premises / footguns — only the agent knows), Deferred prizes harvested from Not-yet-specified, Next concrete goal (present via ask_user_question with ⭐, never prose).
3. Stamp map.md front-matter: status: complete, last: <today>.
4. mv .planning/<effort> .planning/done/<effort>.
5. Skip tidy-next-goals (it only tidies repo-root output/, global keep-last-10).
6. Ship via devops chain (planning artifacts must be committed to origin/main).

**evidence**: Verified against source 2026-08-16: bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts closeEffortReflection() + renderNextGoalNote(); src/tidy-next-goals.ts; .gitignore:48 (/output/ anchored). Executed successfully on effort 2026-08-16-optimize-planning-pipeline-aka-extension (PR #1530).

**candidate skill-name**: wayfind-done-by-hand
