# DRAFT — `land-pr` skill section: Post-merge cleanup (worktree-aware)

> Prototype artifact for ticket 04. Not final — produced to react to. Folds into
> `pi-agent-ext-devops/skills/land-pr/SKILL.md` at build time (after #06 closes).
> Assumes `await_pr_merge` already returned **MERGED** (squash-merge landed on `main`).

## Post-merge cleanup (worktree-aware)

After `await_pr_merge` returns **MERGED**, retire the feature worktree back to `main`'s
tip. This repo runs ≈13 linked git worktrees and `main` is checked out **only** in the
primary worktree — so this is worktree-aware, never a naive `git checkout main`.

### 1. Detect the layout

```bash
git worktree list
```

- **primary worktree** — the entry whose branch is `main`
  (e.g. `/Users/huangziyu/proj/video_generation`);
- **feature worktree** — the one you're in (branch = the PR head).

If you're *already* in the primary worktree (landing from the main repo itself), skip to
step 4 — no detach dance.

### 2. Sync `main` in the primary worktree

`main` can't be checked out in the feature worktree
(`fatal: 'main' is already used by worktree at …`), so update it **in place**. Never
top-level `cd` — `no-cd-drift.sh` blocks it; use `-C`:

```bash
git -C <primary-worktree> pull --ff-only
```

### 3. Retire the feature worktree to `main`'s tip

Refresh `origin/main` **first** so the detach lands on the just-merged commit, not the
pre-merge tip (a dogfooded footgun — `git fetch --prune` *before* `checkout --detach`),
then detach and force-delete the local branch:

```bash
git fetch origin --prune
git checkout --detach origin/main
git branch -D <feature-branch>
```

**`-D` (force), not `-d`:** a squash merge is **not** a direct ancestor of `main`, so
`git branch -d` refuses. The content is identical, only the sha differs — the force-delete
is safe. (`await_pr_merge` already deleted the **remote** branch when `deleteBranch` was
true; the `-D` here handles the **local** copy.)

### 4. Verify with `sweep_branches`

```
sweep_branches({})    # dry-run — expect the feature branch gone from local AND remote
```

Expect: nothing in `deleteLocal`/`deleteRemote`/`review` for the feature branch. If
`sweep_branches` routes a `[gone]`-without-gh-proof branch or an open-PR head ref to
`review`, **surface it to the human** — do not force-delete. This is a concurrent-agent
repo: a fresh branch may be active work. `sweep_branches` treats only `gh` PR
`state=MERGED` as authoritative, which is exactly right here.

### Judgment notes (the footguns this section exists to prevent)

- **Order**: `git fetch --prune` *before* `checkout --detach`, or HEAD lands a commit
  behind.
- **Never `git checkout main`** in a feature worktree — it fails. Detach at `origin/main`.
- **Never `git branch -d`** after a squash merge — it refuses. Use `-D`.
- **Trust `sweep_branches`, not `stale-branches.sh`** — the latter's "no open PR =
  deletable" heuristic once force-deleted active work here.
- **If `sweep_branches` is unsure → escalate**, same escape-hatch discipline as the
  flake-judgment (#03): surface the facts + a ready command, then stop.
