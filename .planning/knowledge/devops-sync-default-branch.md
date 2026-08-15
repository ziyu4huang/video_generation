# Skill candidate: devops-sync-default-branch

## Trigger / symptom
Need to sync a video_generation repo/worktree to the git remote default branch; user asks to "use devops to sync".

## Lesson
All git sync goes through the devops tool chain (`sync_repo`), never raw git (CLAUDE.md standing rule). Validated live 2026-08-15 across four real syncs (last: main eac1151e→07a22829, count 6, verification ok, caller behindDefault 6).

## Proposed procedure
1. Skill doc: `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md`.
2. Plain pi sessions: CLI fallback from repo root: `bun bun-apps/pi-agent-ext-devops/src/sync-cli.ts` (flags: --dry-run, --mode full|rebase|pull, --force, --preserve, --repo-root; exit 0 ok / 1 abort / 2 usage).
3. Dispatch shape (critical): tier small + maxTurns 2 + one shell call + raw JSON paste, budget ~90k. Do NOT request multi-section analysis — fixed per-turn overhead (~25-30k) makes chatty dispatches die on budget.
4. FULL mode advances the default branch ONLY in the worktree holding it; the CALLING worktree is untouched BY DESIGN. Catch the caller up separately (checkout main, or prepare a branch — always pass an EXPLICIT branch name; prepare aborts `detached-head` on empty resolved branch since PR #1443).
5. Read outcome JSON: `verification.ok` must be true; `advanced[]` has from/to/count/subjects; `submodules[]` entries `{worktree, path, sha, flag, matchesRecordedGitlink}`; `caller.behindDefault` = how far behind the calling worktree is.

## Pitfalls
- Submodule flag "+" = gitlink drift (checked out ahead of recorded pointer), NOT dirtiness (ambient `vaults_root/study-news` drift).
- Never stage/commit ambient `.agents/memory/MEMORY.md` (preserve-list hot file) or `vaults_root/study-news`.
- Never `git add -A` in multi-worktree sessions.
- Multi-session hazard: --preserve stash pop can apply a FOREIGN stash entry if another session pushes/pops concurrently between our push and pop (observed 2026-08-15: conflict landed on MEMORY.md, not the preserved path). After any sync with "preserve restore: stash pop conflicted" warning, CHECK preserved.restored:false + inspect the main worktree for UU state before other sessions resume there. Resolution for append-style files: git merge-file --union of :1/:2/:3 stages, then restore --staged.

## Verification steps
Exit 0 + `verification.ok: true` + `caller`/`warnings` reviewed.

## Evidence
Four live syncs 2026-08-15; PR #1443 (squash 0251abff) outcome-schema enrichment.
- Multi-session hazard: --preserve stash pop can apply a FOREIGN stash entry if another session pushes/pops stashes concurrently between our push and pop (observed 2026-08-15: conflict landed on MEMORY.md, not the preserved path study-news). After any sync reporting "preserve restore: stash pop conflicted", check preserved.restored:false and inspect the main worktree for UU state before other sessions resume. Resolution for append-style files: union-merge stages via git merge-file --union of :1/:2/:3, then git restore --staged.
- Flag semantics trap: --preserve REPLACES the default preserve list (default: .agents/memory/MEMORY.md only), it does NOT append. To preserve an extra ambient path AND keep the MEMORY.md default, repeat the flag: e.g. `--preserve .agents/memory/MEMORY.md --preserve vaults_root/study-news`. Omitting this re-lists MEMORY.md as "real dirty" and aborts dirty_tree (observed 2026-08-15).
