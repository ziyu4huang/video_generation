> STATUS: DONE — archived 2026-08-15 (triage verdict: gh.ts exitCode hardening shipped)
# RCA — await_pr_merge silent "aborted" on BEHIND + dirty working tree

**Date:** 2026-08-02 · **Symptom PR:** #1009 (first attempt) · **Tool:** `await_pr_merge` (`bun-apps/pi-agent-ext-devops`)

## Symptom

`await_pr_merge(#1009)` returned `⏹️ … await aborted after 55s (last state: OPEN; checks: 35 pass / 0 fail / 0 pending)` — i.e. all CI green, but **not merged**, reported as "aborted". After stashing the dirty working tree and re-running, the same call merged in 142s.

## Root cause (two defects)

The PR was `mergeStateStatus: BEHIND` (1 commit behind `main`). Branch protection requires the branch to be up-to-date, so green checks alone don't merge — the branch must be rebased first. The tool IS designed to auto-resolve BEHIND, but the path was broken:

**Defect 1 — `rebaseAndForcePush` ignored exit codes + had no autoStash** (`src/gh.ts`):
```ts
await spawn("git", ["fetch", "origin", "main"]);
await spawn("git", ["rebase", "origin/main"]);   // exitCode NEVER checked
await spawn("git", ["push", "--force-with-lease", "origin", branch]);
```
The working tree had uncommitted **tracked** changes (`MEMORY.md`, `map.md` carried over from the `memory` branch). `git rebase` refuses to start with unstaged tracked changes → exits non-zero → the function **ignored it** and force-pushed the *un-rebased* branch. BEHIND never cleared.

**Defect 2 — the recipe loop didn't catch a rebase failure** (`src/recipe.ts`): the `"rebase"` case `await`s `rebaseAndForcePush` with no `try/catch`, and (because of Defect 1) the failure was silent anyway. So each 20s poll re-entered `"rebase"`, the silent no-op repeated, and the loop spun until the **harness aborted the AbortSignal** at ~55s (turn/tool budget) → reported as a misleading **"aborted"** rather than "rebase failed."

Net: a dirty working tree turned the BEHIND auto-resolve into an infinite silent spin that surfaced as an opaque "aborted".

## Fix (harden, not just a memory note)

**`src/gh.ts` `rebaseAndForcePush`:**
1. `git -c rebase.autoStash=true rebase origin/main` — git natively stashes dirty tracked changes before rebase and pops after, so a carry-over dirty tree **never silently blocks** BEHIND resolution (the exact #1009 failure).
2. **Check `exitCode`**: on a failed rebase, `git rebase --abort` (restore pre-rebase HEAD; autoStash preserves the stash) and **throw a clear error**. Check the push exitCode too.
3. Never force-push a branch whose rebase failed.

**`src/recipe.ts` `"rebase"` case:** wrap `rebaseAndForcePush` in `try/catch` → return `{ merged: false, error: "BEHIND rebase+force-push failed: …" }` (a clean `❌` outcome) instead of throwing / spinning / misreporting "aborted".

## Tests

- `gh.test.ts`: updated rebase args (`-c rebase.autoStash=true`); new — failed-rebase throws + runs `--abort` + does NOT force-push; failed-push throws.
- `recipe.test.ts`: new — a `rebaseAndForcePush` that throws → clean error outcome (`merged:false, aborted:false, timedOut:false, error ~= /rebase\+force-push failed/`), not a crash/spin.

## Why not "just stash manually" (memory-only)

A memory note would remind the agent to stash before `await_pr_merge`, but the tool would still silently spin for the next agent on a dirty tree. The code fix makes the tool **self-recover** (autoStash) **and fail loudly** (exit-code checks + clean error) — durable for every future caller.
