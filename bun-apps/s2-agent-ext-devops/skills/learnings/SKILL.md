---
name: learnings
description: Use when an s2-agent toolchain behavior looks wrong, before hand-rolling a workaround — commitScope false-positives on stale local main, bundled-vs-discovered skill precedence, stale deploy core caches, pty dialog key-pacing, and the use-devops-tools-not-hand-rolled-git convention. Append-only dated log; add an entry when a quirk is confirmed.
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

---

## [insight] inspect_extensions "104" adjudicated: it was the JSON findings length, never the Issue count

**Added:** 2026-08-30

Receipted 2026-08-30 (both modes, `output/inspect-ext-receipt-20260830.md`, queue head of `next-goal-20260829-203146`): the historical 2026-08-29 dev reading of **104** was the **JSON `findings[]` length** — every one of them `info`-severity (missing-snippet, no-guidelines, per-source token-tax rows, totals) — NOT the Issue count. The same-day deploy reading of **11** was the **Source count**. Different report lines, both correct under the #2146 vocabulary (power-tool CONTEXT.md: a number without its named line — issue count · JSON findings length · source count · per-source tool count — is an unknown basis).

Decisive evidence: the deployed dist `0.8.0+gb894dc9` (frozen from the same Aug-29 lineage the historical reading came from) returns `findings_length = 104` **exactly** (35 missing-snippet + 55 no-guidelines + 11 tax rows + 2 totals + 1 lazy-extension), all info, `summary.total = 0`. The dist is the historical surface snap-frozen. Dev-now reads 149 findings / 20 sources because main advanced past `b894dc9` (#2151–#2156) — expected drift of a moving surface. Issue count: **0 in both modes**, every capture. No discrepancy existed; the ambiguity was vocabulary, and it is now closed with measured numbers.

---

## [tool-quirk] deployed dists skip `-e` extensions needing non-host modules — non-fatally

**Added:** 2026-08-30

A dist session loads `-e <file>` extensions against a **fixed host-module map** (`@earendil-works/pi-coding-agent`, `typebox`, …). An extension whose imports reach a specifier outside that map — observed: `typebox/compile`, pulled in via a deep `@earendil-works/pi-coding-agent/dist/index.js` filesystem import instead of the host alias — is **skipped with a stderr notice and the session continues without it**. Two consequences:

- A guarded offline probe (register hook → print → `process.exit(0)` before any provider call) **silently degrades into a live model session** — the skip never fires the exit, the `-p` prompt runs, tokens get spent. Observed 2026-08-30: the receipt probe for the deployed mode was skipped this way and became a live session (which then captured the receipt in-band instead — acceptable fallback, but accidental).
- Deep-path imports of host-provided packages don't get host-alias resolution; probe files for dist verification must **import nothing**, or only bare host-provided specifiers.

When a guarded probe produces no marker, read the launch output for a `skipped -e extension` line before assuming the harness hung.

---

## [tool-quirk] long-lived session hosts run extension code frozen at process start — merge cleanup can silently not fire

**Added:** 2026-08-30

Confirmed with receipts during PR #2165 (the merge-CLI → shared branch-cleanup-core migration): the session host (pid observed via `ps`/`lsof … awk '$4=="cwd"'`) had been running since **2026-08-29 20:07** — 23 minutes BEFORE #2150 merged (20:30) — so its in-memory `merge_pr_after_local_ci` was the pre-#2150 build. Symptom: the tool merged #2165, deleted the REMOTE branch (mergeNow's job), but left the LOCAL branch checked out with no detach and no cleanup line — the exact #2143/#2146 recurrence — while the on-disk source (and even the deployed dist) both contained the post-#2150 cleanup.

Diagnostics that worked, in order: `inspect_agent` (loaded tool descriptions vs on-disk `registerTool` descriptions — the missing "On merge, also cleans up the spent branch" sentence named the frozen build), then the host pid's start time (`ps -o lstart`) vs the feature merge timestamp. Diagnostics that MISLED first: grepping the deployed `ext/devops/ext.cjs` for identifiers (`runLocalBranchCleanup`, `cleanupLine`) — minification renames identifiers, so both old and new dists grep 0 while string literals (`"no detach needed"`, `"Branch-cleanup notes"`) grep 1; and assuming the dist was the load source at all (this session loads the workspace tree via the run-dir registry — `inspect_agent`'s `tools[].source.path` settles it in one read).

Recovery that worked: the already-MERGED retry path (`merge-pr-after-ci-cli <pr>`) verifies + runs the branch cleanup as its designed recovery — stash the preserve-listed `.agents/memory/MEMORY.md` past its `dirty_tree` preflight first (the CLI, unlike the extension tool, does not exclude it). That run is ALSO the natural live test for any cleanup-path change — it printed the full migrated call order (detach → deleteLocal → benign already-deleted remote warning → fetchPrune).

Rule: when an in-session tool's behavior contradicts the current source, compare `inspect_agent`'s loaded description against the on-disk one BEFORE blaming the deploy or the code — a host that predates a merge is running that merge's ancestor code, no matter what the tree says now. Post-merge, prefer the CLI twin (fresh process, current tree) for the recovery/cleanup pass.

---

## [tool-quirk] the deploy core cache froze stale cores — the hash didn't cover workspace sources

**Added:** 2026-09-06

Found live by the self-evolve loop (agents-manager t03): the `/agents` CRUD receipt PASSED on the source tree and CRASHED on the deployed tree — `TypeError: isValidAgentName is not a function` — while the deployed version dir's git sha (`0.10.0+g4f8bc04`) **contained** the change.

Root cause chain, all three links required:

1. The core bundle (`s2-agent.js`) is built from `s2-agent/src/cli-sh.ts` but the bundler INLINES the `@repo/*` workspace packages it imports (core-runtime resolves to `src/index.ts`, no dist).
2. The ext bundles (`ext/<name>/ext.cjs`) are built separately and EXTERNALIZE `@repo/*` — at runtime those `require`s resolve against the core's inlined module registry.
3. `computeCoreHash` hashed only `s2-agent/src` (+ pi pkg version, bun version, entry, flags). A core-runtime-only change therefore cache-HIT: `.cores/<hash>` served a stale core, hardlinked into a version dir whose LABEL (git sha) said it was current.

Fix (same branch as the finding): `computeCoreHash` takes `workspaceSrcDirs` — every `@repo/*` dependency of s2-agent, resolved via `Bun.resolveSync`, hashed under its package name — and `buildCore` passes `resolveWorkspaceSrcDirs()`. Regression test in `bun-apps/s2-agent-ext-devops/tests/core-cache.test.ts`.

Diagnosis pattern that worked: `grep -c <newSymbol> <versionDir>/s2-agent.js` — 0 in the stale core, 1 in the fresh `ext.cjs`. Grep PROPERTY names / string literals (minification preserves those), never local identifier names (renamed — both old and new dists grep 0 for locals; see the 2026-08-30 frozen-host entry below for the same trap).

Two side-findings from the same incident:

- Version-dir "noop" redeploys (`ok: true, noop: true`) trust the existing dir — they re-run gates but do NOT rebuild. After any cache-key fix, redeploy with `--force` once.
- Dangling `bun-apps/node_modules/@repo/*` symlinks (targets with a spurious extra `bun-apps/` segment) survive `bun install` ("no changes" — bun resolves workspaces through its own mechanism, not these links) but break the deploy vendor step with `ENOENT … stat`. Repair: from `bun-apps/node_modules/@repo/`, `ln -s ../../<pkg> <pkg>` for each dangling link.

---

## [tool-quirk] pty-driven dialogs eat the FIRST keypress — and "wait for silence" is instant on static surfaces

**Added:** 2026-09-06

Found live (same receipt round, `tui-drive --scenario agents`, receipt 9/11 → FAIL): the driver sent `/agents`, then Enter to open the dialog, then Enter to enter the detail pane — and the detail never opened. The screen snapshot showed the list still rendered; the second Enter had vanished.

Two mechanisms compound:

1. **Fresh-dialog focus handoff:** a `ui.custom` dialog mounted over the composer does not receive keys until the host finishes the focus switch; the first keypress after mount can land on the composer instead (an empty submit — invisible).
2. **Silence-based waits degenerate on static surfaces.** The driver's `waitIdle(quiet)` returns when no bytes arrived for `quiet` ms. A static dialog produces NO bytes, so the wait returns instantly and N retry keys fire in ~1 ms — one coalesced read the host processes before focus handoff completes. All eaten.

Driver-side fix (now in `tui-drive.ts`): retry the key with REAL wall-clock sleeps (`await sleep(700)`), guarded by screen state — only send Enter while the list footer (`enter detail`) is still showing, stop as soon as the target surface (`prompt:`) appears. Exactly what a human does when a keypress is swallowed.

Generalizes: any "wait for the app to be quiet" helper degenerates on surfaces that emit no output. Pace interactive retries with wall-clock sleeps + a screen-content guard, never with output-silence alone.

---

## [convention] hard problems dispatch to the `hard-problem` agentType (zai/glm-5.3) — not flash, not bare defaults

**Added:** 2026-09-06

The repo now ships a project-scope agent definition at `.pi/agents/hard-problem.md` (loaded by every s2-agent session started from the repo root): `model: zai/glm-5.3` with the loop's operating learnings baked into its prompt (stale-core triage, version-label-vs-content, pty pacing, frozen hosts, skill precedence).

Dispatch convention:

- **`agentType: "hard-problem"`** for genuinely hard analysis — deployed-vs-source drift, receipt forensics, cache/build staleness, cross-process debugging. The big model is the point; flash is for cheap lookups.
- `explore` / `plan` (read-only built-ins) stay the default for cheap codebase questions.
- The tui-drive dispatch/parallel/viewer scenarios seed this definition into their scratch projects and dispatch through it — the receipt's `childModelIsGlm53` check proves the binding end-to-end (a `Task(` row showing `glm-5.3` and not `glm-5.3-flash`), so a silent downgrade to flash fails the receipt instead of passing unnoticed.

When a NEW learning is confirmed, append it here AND fold the one-line version into `.pi/agents/hard-problem.md`'s learnings list — the definition is what subagents actually load; this file is what humans and sessions read.
