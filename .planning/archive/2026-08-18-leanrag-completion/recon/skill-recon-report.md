# Read-only skill reconnaissance — repo /Users/huangziyu/proj/video_generation__memory

(Task: read-only-skill-reconnaissance-in-repo-u. No edits made to repo files.)

## 1. DevOps workflow skill

**File:** `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md` (fully read)

### Plain-session CLI fallbacks (verbatim commands, run from repo root)

The skill states all CLIs take `--help`, print JSON on stdout, exit 0 success / 1 fail-or-abort / 2 usage error. They are THIN wrappers around the same recipes the tools use (same `createLiveSpawn` + `createBranchClient`), so CLI and tool cannot diverge.

```bash
bun bun-apps/pi-agent-ext-devops/src/sync-cli.ts [--dry-run]
# supports: --mode full|rebase|pull, --dry-run (plan only, zero mutations), --force,
# --preserve <path>, --preserve-strict; non-zero exit on abort (dirty tree, divergent default branch)

bun bun-apps/pi-agent-ext-devops/src/main-health-cli.ts        # is main green? (full matrix + gates, read-only)
bun bun-apps/pi-agent-ext-devops/src/sweep-cli.ts [--execute]  # dry-run by default
bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts [--all]   # --all overrides change-scoping
bun bun-apps/pi-agent-ext-devops/src/prepare-cli.ts --rebase [--force-push]
bun bun-apps/pi-agent-ext-devops/src/verify-merge-cli.ts <pr> [--scope a,b] [--fetch]
```

Notes:
- `--fetch` (CLI) / `allowFetch` (recipe) on verify-merge pulls the squash object right after `gh pr merge` (the squash commit exists only on remote; otherwise verdict is UNVERIFIED, not CLEAN).
- **`await_pr_merge` has NO standalone CLI** — use the finish sequence wrapper:
  ```bash
  bun bun-apps/pi-agent-ext-devops/src/pr-finish-cli.ts
  ```
  (preflight → local-CI gate → merge gates → squash-merge → verify_merge → branch cleanup; cleanup detaches the worktree onto the merge commit before deleting the spent head branch).
- NOTE (unverified): I did not get to run `--help` on prepare-cli/local-ci-cli before budget ran out; the flags above are as documented in SKILL.md. The CLI files' existence under `bun-apps/pi-agent-ext-devops/src/` was not individually re-listed (aborted), but SKILL.md names them authoritatively.

### In-order workflow (the chain, run in order)

1. **`prepare_branch`** — worktree-safe branch create/rebase/force-push-with-lease. Covers BEHIND state before merge. Aborts `worktree-conflict` before mutating; aborts `rebase-conflict` (runs `git rebase --abort` first). `forcePush` defaults **false** — opt in with `--force-with-lease`. Prefer `dryRun: true` first.
2. **`local_ci`** — typecheck + tests scoped to packages changed vs `origin/main`, plus EVERY step of the workflow's `regression-gates` job (~14 gates). Offline; derived at runtime from `.github/workflows/ci.yml.disabled` (per-package cmd from `tests` matrix via `src/ci-matrix.ts`, gate list via `src/ci-gates.ts`). Change-scoped — not a health check for main.
3. (**2b.** `main_health` — full matrix + gates in the worktree holding the default branch, read-only; aborts-unhealthy if no worktree holds it; typecheck exit 127 → `toolchainMissing` not failingPackages; run before starting work, do NOT gate merge on it.)
4. **`await_pr_merge`** — runs local_ci over the PR's changed packages, then squash-merges when green AND CLEAN/mergeable. Blocks on red CI, detection error, BEHIND, non-CLEAN mergeState. No remote CI, no polling. BEHIND → back to step 1.
5. **`verify_merge`** — confirm merged, file scope vs optional `expectedScope` (verdict CLEAN / CONTAMINATED / **UNVERIFIED** — UNVERIFIED is not a pass), branch **spent** (keys off gh `headRefOid`, not `git branch --merged`, because squash rewrites).
6. **`devops_retrospect`** — advisory, never-blocking anomaly review (reflog, force-push signature, scope drift, dirty tree, divergence).

Plain-session ordering per repo CLAUDE.md: sync → prepare branch → commit → local CI → PR → squash merge (`gh ship` = `gh pr merge --squash`, never `--auto`) → verify → sweep.

### Key flags / rules

- **Branch naming**: not specified in SKILL.md (no branch-name flag documented there).
- **local_ci scope selection**: change-scoped vs changed packages vs `origin/main` by default; CLI `--all` overrides; `strict: true` means "also run audits that have NO workflow step" (`check-workflow-patterns.mjs`, `verify-skills.ts`) — the audit gates proper are already in the job.
- **Dirty-tree rules**: `sync_repo` preserves auto-managed hot files — default preserve list `['.agents/memory/MEMORY.md']`, stashed before advance, restored after. ALL OTHER uncommitted tracked work still aborts `dirty_tree` (stash/commit first). Override via `preserve:`; `preserve: []` disables preserve entirely (strict gate).
- **Lockfiles**: no explicit lockfile rule in this SKILL.md (repo CLAUDE.md owns: never commit `package-lock.json`; `bun install` from `bun-apps/` only).
- **Never parse `git show --stat` yourself** — `--numstat` is the machine-readable form (`.../tail` abbreviation broke prefix matches, PR #1360).
- **No raw-bash git/gh for owned phases**; old `scripts/sync-repo.sh` fallback was deleted — do not reinvent it.
- **sweep_branches**: worktree guard covers remotes too — a branch checked out in ANY worktree is never deleted, local or remote; guard runs twice (plan time + immediately before each delete).
- Tools are throw-free (structured `aborted`/`warnings` + `summary`), record git invocations in `commands[]`, honor `dryRun`.

## 2. Wayfind skill suite

**Location:** `bun-apps/pi-agent-ext-wayfind/` — 16 skills under `skills/` (each `<name>/SKILL.md`). There is no single "wayfind" SKILL.md; the dispatcher is the extension + `procedures/wayfinder.md`.

Key SKILL.md files read:
- `bun-apps/pi-agent-ext-wayfind/skills/grilling/SKILL.md` (fully read)
- `bun-apps/pi-agent-ext-wayfind/skills/to-spec/SKILL.md` (fully read)
- `bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md` (read lines 1–120 of 163; tail unread)

### How to RUN wayfind (plain pi session)

Wayfind is a **slash-command extension**, not a CLI/bun script. Options:

1. **Registered (normal)**: it is registered in `bun-apps/pi-agent/run-dir/manifest.json`; the pi-agent wrapper (`bun bun-apps/pi-agent/src/cli.ts`, which auto-loads run-dir extensions and skills) exposes `/grill` and `/wayfind`.
2. **Ad-hoc**: `pi -e ./bun-apps/pi-agent-ext-wayfind/extensions/wayfind.ts` — loads the extension AND the skills via the `pi` manifest in package.json.

Commands (verbatim from README):
- `/grill me [topic]` — plain grilling interview, no artifacts
- `/grill docs [topic]` — **flagship** — grilling + writes CONTEXT.md glossary + ADRs inline
- `/grill done [--seed-plan]` — end grill; `--seed-plan` reads CONTEXT.md + writes a task_plan.md seed
- `/grill domain` — glossary + ADR discipline directly
- `/wayfind [destination]` — chart new map under `.planning/<effort>/`; no args = work next frontier ticket; `/wayfind -- <destination>` force-charts a name beginning with a reserved keyword
- `/wayfind status [effort]` — frontier + open/closed/claimed/fog counts
- `/wayfind spec [effort]` — synthesize spec (PRD) at `.planning/<effort>/spec.md`
- `/wayfind tickets [effort]` — break spec/plan into tracer-bullet tickets under `.planning/<effort>/tickets/`
- `/wayfind seed [effort]` — route-aware flatten tickets → task_plan.md; refuses to overwrite
- `/wayfind sync [effort]` — close tickets whose plan-coordinator phase reported completed (reverse seam reads `globalThis.__piPlanPhases`)
- `/wayfind done [effort]` — closing ceremony: harvest map into `output/next-goal-<ts>.md` + next goal; writes `status: complete`, moves effort to `.planning/done/`
- `/wayfind validate [effort]` — validate effort structure: tickets, frontmatter, blocking edges

Chain: `grill docs → wayfind spec → wayfind tickets → wayfind seed → (execute plan) → wayfind sync`.

### Stages — grilling (verbatim-important)

Grilling = relentless interview mapped as a **design tree**, worked in **rounds**; the **frontier** = decisions whose prerequisites are settled. Ask the whole frontier per round, numbered questions each with a recommended answer:

```
❓ **Q1** - **<question title>**: <question body...>
➡️ <your recommended answer>
```

- Facts are the agent's job (dispatch a sub-agent; don't block the rest of the frontier on it); **decisions are the user's**.
- Freshness: confirm branch is current before treating facts as ground truth (`git rev-list --count HEAD..origin/<default>`); if behind, prefer rebasing.
- Done when the frontier is empty; do not act until the user confirms shared understanding.

### Stages — to-spec / synthesize

`to-spec` (`disable-model-invocation: true`; invoked via `/wayfind spec`) is **synthesis only, no interview**. Entry criteria: map exists and `## Not yet specified` is empty (or all items explicitly deferred with owner). Writes `.planning/<effort>/spec.md` (never `docs/specs/`) with required sections: 1. Problem Statement, 2. Solution, 3. User Stories, 4. Implementation Decisions (no file paths/code; exception: decision-encoding prototype snippets), 5. Testing Decisions, 6. Out of Scope, 7. Further Notes. Uses CONTEXT.md glossary vocabulary; respects ADRs.

### Artifacts & where

- `.planning/<effort>/map.md` — the map (index, not store): Destination / Notes / Decisions so far / Not yet specified (fog) / Out of scope; lifecycle front-matter `status: active|complete|paused`
- `.planning/<effort>/tickets/NN-slug.md` — decision tickets; `type:` ∈ research|prototype|grilling|task; `claimed:` line = lock; `blocked by:` text edges; frontier = open+unblocked+unclaimed
- `.planning/<effort>/spec.md`, `tickets/`, `task_plan.md` seed, `output/next-goal-<ts>.md`; `CONTEXT.md` + `docs/adr/` from `/grill docs`

### Verify

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )   # README says 263 tests; CLAUDE.md: check=biome, typecheck=tsc — run BOTH check and typecheck
```

Note: six skills (research, prototype, subagent-dispatch-discipline, code-review, diagnosing-bugs, writing-for-agents) were deleted 2026-08-16 (ADR-wayfind-0007) — superseded by superpowers counterparts; do NOT re-port.

## 3. superpowers using-superpowers → references/pi-tools.md

**Locations found:**
- Repo (richer, current): `bun-apps/pi-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md` (fully read)
- Embedded snapshot (older, thinner): `~/.pi/agent/embedded-assets/f48839c20a35/pi-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md` (and a second copy under `c55aef6860a2`)
- NOT present under `~/.pi/agent/skills/` (only hyperframes*/media-use there), `~/.pi/skills/` (absent), or the pi-coding-agent package cache dirs.

### Load-bearing subagent-dispatch directives (from the repo copy)

- **Provider**: the `subagent` tool comes from `pi-agent-ext-subagent` (the OLD embedded copy says `pi-agent-ext-workflow` — outdated): `subagent({ task, model?, tier?, tools?, excludeTools?, cwd?, commitScope?, tokenBudget?, spendBudget?, timeoutMs?, schema?, schemaRepairAttempts?, agentType?, retryOnTransient?, watchdog? })`.
- **Tier vs raw model id**: schema explicitly recommends `tier` over concrete `model` — tier resolves via `~/.pi/workflows/model-tiers.json` (editable `/workflows-models`), portable across users; raw ids are user-specific. Priority: `model` > `tier` > session model. SDD role→tier: implementer=`medium`, focused research=`small`, synthesis/final-review=`big`.
- **commitScope (SDD)**: pass commitScope with the task's declared file scope (e.g. `["src/auth/","tests/auth/"]`); tool records HEAD before dispatch and flags committed paths outside scope as ⚠ violation (detection only, never auto-reverts). Catches `git add -A` sweeping scratch files into main at squash-merge. `[]` for read-only subagents. Ignored for worktree-isolated runs. Repo CLAUDE.md adds: watchdog OFF (omit) for write-heavy implementer dispatches — L1 flagged ancestor-origin/main files out-of-scope; reserve watchdog for read-only verification.
- **Watchdog defaults**: `watchdog:{l2:true}` = L1 (free local typescript-language-server scan; errors→blocker, warnings→concern) + L2 (read-only model-review subagent via `resolveModelRole({capability:"review")`→falls back to `big` tier; structured `{severity,file,finding}`). Findings advisory only. Edit-gated (no commits → skip). `true` = L1 only. pi-tools says use `{l2:true}` for implementer/fix dispatches, omit for non-editing — but repo CLAUDE.md's standing rule overrides for this repo (omit by default; see above).
- **Parallel fan-out**: use the **`workflow` tool's `parallel()`** — NOT multiple `subagent` calls. The `subagent` tool declares `executionMode:"sequential"`; any sequential call in a turn serializes the whole batch. `parallel(thunks)` bounded 16 live / 1000 total, results in input order; `pipeline(items, ...stages)` for ordered chaining. Workflow dispatches go via a separate `createAgentSession()` path, so not throttled. "This is the ONE sanctioned concurrency path."
- **Timeout default**: omitting `timeoutMs` falls back to `DEFAULT_TIMEOUT_MS` = 15 min (not "no timeout").
- **Budget**: `tokenBudget`/`spendBudget` soft guidance (not mandatory), abort status `budget`; pairs with `timeoutMs`.
- **Status contract**: SDD implementer returns `**Status:** DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED`, parsed into `details.report` (SddReport), distinct from process status.
- **Persistence**: runs written to `~/.pi/subagents/runs/<id>.json` (last-N=200).
- **If no subagent tool available**: do NOT fabricate `Task` calls; execute sequentially or explain the capability is missing.
- **Peer-extension code** imports `spawnSubagent` from `@repo/pi-agent-ext-subagent`; subprocess isolation via `spawnSubagentSubprocess` from `@repo/pi-agent-ext-subagent/src/spawn-subagent-subprocess.ts` (.ts subpath to avoid ~8s CLI boot).
- **SDD workspace**: `PI_PLANNING_EFFORT=<effort>` → artifacts under `.planning/<effort>/sdd/` (briefs/, reports/, reviews/, progress.md); fallback flat `.planning/sdd/` (gitignored). Inline awk task-brief extraction and review-package git commands are given verbatim in the file.
- **Task lists**: no core tool; use an installed todo/task extension or plan files / `TODO.md`; treat legacy `TodoWrite` references as the task-tracking action.

> Folded from stray `.planning/2026-08-16-skill-recon-report/` (untracked since 2026-08-18) into `recon/` on 2026-08-18 — repo hygiene, closing the last untracked artifact of the budget-rebalance session trail.
