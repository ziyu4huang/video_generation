# Skill candidate: controller-no-bash-sdd-via-subagents

**Candidate skill-name:** sdd-via-subagent-orchestration

**Trigger/symptom:** A skill (e.g. SDD's subagent-driven-development) assumes the CONTROLLER runs bash directly (sdd-workspace / task-brief / review-package scripts, git rev-parse, progress.md appends), but the controller session's tool set has NO direct bash/read/write/grep — only subagent/workflow dispatch tools. (Observed in the superpowers/wayfinder worktree config: tool set = {subagent, subagents, workflow, workflow_control, workflow_help, subagent_runs}.)

**Lesson:** Every mechanical step the skill assumes the controller runs must instead be dispatched as a small subagent with bash. This is CONFIG-DEPENDENT — another pi worktree/extension binding may give the controller bash; verify the session's tool list at start.

**Proposed procedure:** When running SDD (or any bash-assuming skill) as a no-bash controller: batch the mechanical bash into one small subagent per phase rather than one dispatch per command — e.g. one "setup" subagent (create branch off origin/main + run sdd-workspace + seed progress.md + extract task-brief + record BASE), one "review-package + audit-commit" subagent after each implementer. Keep implementer/reviewer dispatches as the heavy tier-bounded ones; keep mechanical-bash dispatches at small tier. progress.md is gitignored/transient — never git-add it; commit only briefs/reports/reviews audit trail. (Repo CLAUDE.md also: watchdog OFF for write-heavy implementer dispatches; the independent reviewer subagent is the real gate.)

**Evidence:** batch-tui SDD execution (PR #1289) ran entirely via this pattern: ~4 dispatches/task (setup -> implementer -> reviewpkg+audit -> reviewer) x 6 tasks + final review, all mechanical steps as small-tier bash subagents.
