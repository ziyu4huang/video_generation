# Git Commit & PR Merge SOP

Standard operating procedure for committing changes and landing them on `main`
via a pull request in this **multi-worktree** monorepo.

> Why a dedicated SOP: multiple worktrees/sessions work concurrently, so
> `origin/main` keeps advancing under you — another session may even fix the
> *same* bug. Pushing/merging without first syncing brings redundant commits or
> conflicts. This flow encodes the lessons (collision auto-skip, the
> forward-merge 1:1-SHA preference, the propose-then-confirm cleanup rule, and
> SOP #320 branch hygiene) into one checklist.

---

## TL;DR — the 7 steps

1. **Branch** off `origin/main` (never commit on detached HEAD / `main`).
2. **Commit** — one logical change per commit, English message, conventional prefix.
3. **Push + open PR** — `git push -u` then `gh pr create --base main`.
4. **Pre-merge sync** — fetch, check divergence, rebase if behind, `--force-with-lease`.
5. **Merge** — forward-merge (default) for 1:1 SHA mapping; squash only for throwaway chores.
6. **Post-merge cleanup** — *propose → confirm → execute* (delete branch, sync main).
7. **Branch hygiene** — run the devops `sweep_branches` tool (dry-run default); expect **0 stale**.

---

## 0. Prerequisites & conventions

- **Never push to `main` directly.** Always go through a feature branch + PR.
- **Write output in English** — commit messages, PR titles, branch names. Discussion may be in 繁體中文.
- **Shell discipline** — never top-level `cd`; wrap as `( cd <dir> && ... )` or use `--cwd`/`-C` (a `PreToolUse` hook blocks bare `cd`).
- **One logical change per branch/PR.** If the working tree spans unrelated changes, split into separate branches.
- **Working tree cleanliness for self-improve `fix:true`** — a dirty tree refuses to run; commit or stash first.
- **Pre-commit hook** (`core.hooksPath = .githooks`) — 2 MB size guard. Fresh clones: `bash scripts/setup.sh`.

### Excluding noise from commits
- **Submodules** (e.g. `vaults_root/pi-agent-vault`): `git add` only when the recorded pointer (commit SHA) actually changed — "modified content" in the submodule's own working tree is **not** a parent-repo change. Check `git diff --submodule`.
- **Planning artifacts** (`task_plan.md`, `findings.md`, `progress.md` from planning skills): transient working memory — exclude from real commits (or gitignore them).

---

## 1. Branch off `origin/main`

This repo's worktrees are usually left on **detached HEAD** after a previous merge
(that's the SOP end-state). Do **not** commit on the detached HEAD or on `main`.

```bash
git fetch origin
git switch -c feat/<short-scope> origin/main   # branch fresh off latest main
```

> If you are on a stale local `main` (ahead/behind `origin/main`), branch from
> `origin/main` explicitly, not from `main`.

### Commit granularity
- Stage only the files belonging to **one** logical change.
- Commit message — conventional prefix + imperative mood + one-line summary, blank line, optional body:

```
feat(prompt-cost): trim subagent/ltx schemas + add promptSnippet to tools

Drops ParallelTask/DynamicParallel schemas to generic objects (~600 tok/req),
removes runId/maxRuntimeMs aliases, condenses CLAUDE.md. Updates schema tests.
```

Common prefixes: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `perf`.

```bash
git add <files...>                       # explicit, never bare `git add .`
git commit -m "..."                      # or write the body in an editor
```

### Verify before pushing
Run the affected package's tests (uniform runner: `( cd bun-apps/<pkg> && bun test )`).
Some packages need a build first — `pi-agent-ext-workflow` requires
`bun run build && bun test` (tests import compiled `../src/*.js`).

---

## 2. Push + open PR

```bash
git push -u origin feat/<short-scope>
gh pr create --base main --head feat/<short-scope> --title "..." --body "..."
```

PR body should note **why**, the verification done (tests run + result), and any
follow-up. Keep the title in sync with the commit's summary line.

---

## 3. Pre-merge sync — **the critical step**

Because another session may have merged to `origin/main` while your PR was open
(or even fixed the *same* bug — this has happened byte-for-byte), always sync
right before merging:

```bash
git fetch origin
# left = main-only, right = branch-only
git rev-list --left-right --count origin/main...HEAD
# what does main have that you lack?
git log HEAD..origin/main --oneline
```

- **Up to date (left=0):** proceed to merge.
- **Behind (left>0):** rebase and force-push:
  ```bash
  git rebase origin/main          # auto-skips identical already-applied patches
  git push --force-with-lease origin feat/<short-scope>   # NEVER bare --force
  ```
- **Collision (same fix already on main):** `git rebase` auto-skips the redundant
  commit; verify with `git log` then force-push.

> **Squash preflight (avoid the #213 near-miss):** after `reset --soft` + re-squash
> onto an advanced `origin/main`, ALWAYS `git diff origin/main HEAD --stat` and scan
> for files you never touched being reverted. A blind `reset --soft origin/main`
> once reverted 22 files of a concurrently-merged PR — caught only by a pre-push
> diff review. Rule: **fetch right before squash, and diff-inspect the result.**

---

## 4. Merge — forward-merge (default) vs squash

| | Forward-merge (DEFAULT) | Squash |
|---|---|---|
| Command | `gh pr merge <n> --merge` | `gh pr merge <n> --squash` |
| SHA mapping | **1:1** — your local squashed commit lands on main verbatim | rewritten — local branch ≠ the commit main receives |
| When to use | any PR you care about tracking | throwaway chore PRs where the branch is deleted after |

**Forward-merge is the default** because it keeps the local squashed commit's SHA
landing on `main` 1:1 (`local branch == remote branch == the commit main receives`),
which avoids "which commit is on main?" confusion. To use it cleanly:

1. **Squash locally first** — collapse the branch to one clean commit before pushing.
2. Push that single commit.
3. `gh pr merge <n> --merge` → the merge commit forward-merges your single commit.
4. No `reset --hard` needed afterward — verify with
   `git branch --contains <sha> -r` (lists both `origin/main` and `origin/<branch>`).

### gh gotchas (iter-7)
- **`--delete-branch` FAILS when `main` is checked out in another worktree**
  (`fatal: 'main' is already used by worktree at ...`). The GitHub-side merge still
  succeeds — only the local delete/checkout fails. Fix: drop `--delete-branch`,
  delete the branch manually in step 5.
- **`--disable-auto` SILENTLY NO-OPS** — exits 0 with no output and leaves the PR
  OPEN. Use plain `gh pr merge <n> --squash|--merge` only.
- **Always confirm the merge actually happened:**
  ```bash
  gh pr view <n> --json state,mergedAt -q '{state:.state, mergedAt:.mergedAt}'
  # state == "MERGED" and mergedAt non-null
  ```
  Never `git reset --hard origin/main` on the *assumption* it merged.

---

## 5. Post-merge cleanup — **propose → confirm → execute**

The merge itself (step 4) is the one irreversible thing done on SOP authority once
you said "merge". **Everything after is proposed-then-confirmed**: deleting a remote
branch and rewriting the local `main` ref are hard to reverse, so state exactly what
you'll run and **pause for confirmation** before any of it.

Propose this set, then run each **after the user confirms**:

```bash
# (1) delete the remote branch
git push origin --delete feat/<short-scope>

# (2) drop stale tracking refs
git fetch --prune origin

# (3) sync local main to freshly-merged origin/main
#     (the PRIMARY worktree owns `main` — run there, or use -C from a linked worktree)
git fetch origin
git merge --ff-only origin/main        # aborts on divergence; see gotcha below

# (4) delete local merged branches (only --merged into main, not checked out elsewhere)
git branch --merged origin/main        # review first
git branch -d feat/<short-scope>       # only those confirmed merged & not in another worktree
git worktree list                      # '+' prefix = locked/checked-out; do not delete those

# (5) if THIS worktree was on the merged branch: detach → delete → branch off merged commit
git switch --detach
git branch -d feat/<short-scope>
git switch -c scratch/post-merge       # or the next feat/<...>, off the merged commit
```

Final check — nothing left but `origin/main`:
```bash
git branch -r --merged origin/main
```

### ff-merge / verification gotchas
- **`--ff-only` ABORTS with uncommitted working-tree changes** when the merge adds
  files that exist locally as untracked: `git stash push -u` → ff-merge → `git stash pop`.
- **Don't trust ff-merge output alone** — verify pointers actually moved:
  `git rev-parse --short main origin/main` must match; redo if not.
- **Post squash-merge cleanup** (legacy squash variant): `git reset --hard origin/main`
  to realign, then push. (Not needed for the forward-merge default.)

---

## 6. Branch hygiene — SOP #320

Branches are deleted at **PR-merge time**, never left to accumulate. Enforcement is
the devops `sweep_branches` tool — run it after every merge and at the start of each
cycle (`stale-branches.sh` was removed in the devops-scripts unification):

```
sweep_branches({})           // dry-run (default): lists branches outside the keep-set, each w/ PR state
sweep_branches({ execute: true })  // delete the high-confidence set
```

For the full finish flow (merge gates → squash-merge → verify → cleanup), use the
`devops-pr-finish` bin (`bun-apps/pi-agent-ext-devops/src/pr-finish-cli.ts`).

- Keep-set: `main` / current branch / worktree-checked-out / open-PR branches.
- Expect **0 stale** on a clean repo.
- Full procedure + pitfalls (squash-merge ancestry trap, worktree-concurrent safety):
  the **`branch-cleanup`** project skill.

---

## Decision guide — which merge mode?

- **Default → forward-merge (`--merge`)** after a local squash: 1:1 SHA tracking, the
  common case for real feature work.
- **Squash (`--squash`)** for throwaway chore PRs where the branch is deleted right
  after and you don't care about SHA continuity.
- **Never** push to `main` directly; **never** bare `git push --force` (always
  `--force-with-lease`).

---

## Quick reference

```bash
# ── branch + commit ──────────────────────────────────────────────
git fetch origin
git switch -c feat/<scope> origin/main
git add <files...>
( cd bun-apps/<pkg> && bun test )          # verify before pushing
git commit -m "feat(<scope>): summary"

# ── push + PR ────────────────────────────────────────────────────
git push -u origin feat/<scope>
gh pr create --base main --head feat/<scope> --title "..." --body "..."

# ── pre-merge sync ───────────────────────────────────────────────
git fetch origin
git rev-list --left-right --count origin/main...HEAD   # left=main-only right=branch-only
git rebase origin/main                                 # if behind
git push --force-with-lease origin feat/<scope>        # NEVER bare --force

# ── merge (default: forward-merge) ───────────────────────────────
gh pr merge <n> --merge
gh pr view <n> --json state,mergedAt -q '{state:.state,mergedAt:.mergedAt}'

# ── post-merge cleanup (PROPOSE → CONFIRM → RUN) ─────────────────
git push origin --delete feat/<scope>
git fetch --prune origin
git merge --ff-only origin/main          # in the primary worktree (owns main)
git branch -d feat/<scope>
sweep_branches dry-run                 # expect 0 stale
```

---

## Related
- Vault SOP card: `pr-merge-sync-sop` (multi-session collision handling, full iter-7 gotchas)
- `branch-cleanup` project skill + the devops `sweep_branches` tool (SOP #320)
- `self-improve-sop` — branch-off-main / clean-tree / detach rules for the workflow loops
