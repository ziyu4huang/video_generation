---
name: learnings
description: Use when an s2-agent toolchain behavior looks wrong, before hand-rolling a workaround — commitScope false-positives on stale local main, bundled-vs-discovered skill precedence, and the use-devops-tools-not-hand-rolled-git convention. Append-only dated log; add an entry when a quirk is confirmed.
---

# Agent Learnings

Durable, team-wide learnings about the s2-agent toolchain in this repo — tool quirks, architectural facts, and conventions surfaced during work. Per-user lessons also live in the memory store at `~/.pi/agent/pi-hermes-memory/failures.md`; this file captures the subset worth sharing across the team and version-controlling.

Entries are append-only and dated. Each is tagged `[tool-quirk]`, `[insight]`, or `[convention]`.

---

## [tool-quirk] `subagent` commitScope violations can be false positives on a stale local `main`

**Added:** 2026-08-07

The `subagent` tool's `commitScope` violation detector compares a branch's committed paths against the **local `main` ref, not `origin/main`**. When a feature branch is based on a stale local `main` that lags `origin/main`, the detector flags every file that differs from the stale local main as out-of-scope — producing large false-positive lists (observed: 107 files flagged) even when the true PR diff vs `origin/main` is clean (was: 2 files).

**Before acting on a reported commit-scope violation** (e.g. dispatching a history rewrite / force-push cleanup), verify the real net diff first:

    git diff origin/main...HEAD --stat
    git show --stat HEAD

If those show only the intended in-scope files, the violation is a false alarm — no cleanup is needed. Common in worktrees that frequently sit behind `origin/main`.

Confirmed root cause (PRs #1068/#1069 cross-check): the guard diffs the subagent's commits against stale *local* `main`, so it also flags file paths changed by *prior* merged PRs on `origin/main` that local `main` hasn't fast-forwarded to — not just the current branch's work. Verify with `gh pr view <N> --json files`.

---

## [insight] pi-coding-agent skill precedence: bundled `--skill` always wins over `resources_discover`

**Added:** 2026-08-07

pi-coding-agent loads skills from CLI `--skill <dir>` args (from manifest `skills[]` / `binarySkills` — the **bundled** skills) **before** skills discovered via an extension's `resources_discover` handler, and dedups **first-wins** keyed on the skill `name`.

Consequences:

- A **bundled** skill always wins over a same-named personal skill an extension discovers.
- The diagnostic `name "X" collision … (skipped)` means the **bundled** copy is the active winner and the personal one was dropped — it is **informational noise, not a functional bug**; the correct (bundled) skill is already loaded.
- There is **no override/precedence hook** in the `resources_discover` contract (it only accepts `skillPaths: string[]`), so you cannot make a discovered skill beat a bundled one. To eliminate a collision, **remove the duplicate source** rather than trying to change precedence.

The `hermes-memory` extension uses `~/.pi/agent/pi-hermes-memory/skills/` as **both** a writable `skill_manage` store **and** a discovery source — that dual purpose is what collides with its own bundled skills. Bundled skills ship from `bun-apps/s2-agent-ext-hermes-memory/skills/`; `deploy.ts` copies the whole skill dir (including non-`SKILL.md` files — history: the pre-Bun-port bash dedup launcher it then shipped, since deleted) in all deploy modes (`--bundle` / `--standalone` / `--exe` / `--snapshot`).

---

## [tool-quirk] promoting a doc into an active SKILL.md brings its `.sh` mentions under the no-bash-skills docs seal

**Added:** 2026-08-29

`bun-apps/tests/no-bash-skills-guard.test.ts` (gate `test:no-bash-skills`) scans every **active `SKILL.md`** for `.sh` mentions. Docs that previously lived outside `skills/` (e.g. the old `docs/agents/` folder) were never scanned — converting them to skills (PR #2135) surfaced mentions the seal rejects, and `run_local_ci` went red only AFTER the promotion.

Rules that bite during such a migration:

- A mention of a `BANNED_TOOLS` name (the five deleted bash launchers listed in the guard's `BANNED_TOOLS` const — including the dedup and run-test ones) is an **unconditional violation on the docs surface** — no history-label relief; describe the launcher without naming it.
- Other `.sh` mentions pass only if they (a) are a D6 exception, (b) **resolve on disk** from the repo root (so a bare `setup-repo-deps.sh` must be written as `scripts/setup-repo-deps.sh`), or (c) carry a same-line history label (`history`/`old`/`used to`/`retired`/`pre-Bun-port`).

Before promoting a doc to a skill, grep it for `\.sh` and pre-fix mentions — the seal is a local_ci **gate**, not a lint.

---

## [convention] Use the repo's git/gh tooling (devops extension + scripts/), not hand-rolled git

**Added:** 2026-08-07

Before any git/GitHub operation, reach for the repo's purpose-built tooling instead of dispatching a custom subagent that runs raw `git`/`gh`. The `s2-agent-ext-devops` extension and `scripts/` already handle base-ref correctness, worktree edge cases, and local-CI gating that hand-rolled git gets wrong.

| Operation | Use this | Not |
|---|---|---|
| Sync a worktree/repo to the latest default branch | devops **`sync_default_branch`** tool (`mode: "full"`) — `merge --ff-only` by default (aborts on divergent, never loses commits); `force: true` for `reset --hard`; worktree-aware across superproject + submodules | hand-rolled `git fetch` + `reset --hard` + `pull --ff-only` |
| Rebase current branch onto origin/main | `sync_default_branch` (`mode: "rebase"`) | manual `git rebase` |
| Merge origin/main into current branch | `sync_default_branch` (`mode: "pull"`) | raw `git merge`/`pull` |
| Merge a PR | `merge_pr_after_local_ci({ prNumber })` pi tool — runs the `run_local_ci` gate (typecheck+tests scoped to changed packages vs `origin/main`), then squash-merges; refuses on BEHIND/non-CLEAN | raw `gh pr merge --squash` / `gh ship` |
| Inspect a PR | `show_pr_status({ prNumber })` pi tool | `gh pr view` parsing |
| Clean up branches | `sweep_merged_branches({ execute: true })` pi tool (gh-confirmed merges only) | manual branch deletion |

Why it matters: hand-running git in a subagent against a stale worktree is what produces the `commitScope` false-positive noise (see the `[tool-quirk]` entry above) and skips the local-CI self-verification that `merge_pr_after_local_ci` enforces. Note: the devops tools are s2-agent extension tools — if they aren't directly callable in the current session, invoke them via a subagent rather than falling back to raw git.
