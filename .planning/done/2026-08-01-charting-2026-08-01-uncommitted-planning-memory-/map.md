> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: durable project MEMORY.md in git

## Destination

Make agent-written **project** memory (`.agents/memory/MEMORY.md`) reliably **land in
git** — closing the gap left by the `2026-07-29-persistent-to-planning` effort, which
shipped dir-resolution + index-merge + search-merge but **no commit path**. Mechanism
scope (pinned at chart): an **autonomous lifecycle hook commits memory changes to the
*current* branch, batched per session/goal, opt-in per effort** — so memory rides the
branch it relates to (PR-reviewable, worktree-aware) instead of accumulating as
uncommitted edits that get lost on branch switch / stash / worktree discard.

## Notes

- **"Plan, don't do" override.** This effort carries **execution into the map**: the
  destination is a change-made-in-place (a durability mechanism), so tickets 06 (build)
  and 08 (verify) are deliverables, not just decisions. The grilling tickets (01–05, 07)
  still resolve one decision per session.
- **Build status (2026-08-01).** ✅ **Destination reached.** Ticket 06 (the autocommit hook)
  is built & verified (commits `1407364e`+`c8d6b649` after rebase; repo-local config overlay;
  `message_end` + ~20s debounce → guarded never-throws pathspec-limited commit; §-union merge
  driver). Ticket 08 is verified via its sub-map (`.planning/2026-08-01-ticket08/`): a real-git
  integration suite (`5b923407`) drives `realGitOps` against actual `git` and proves all 5
  durability properties — commit-lands, **no-sweep**, branch-switch, §-union merge, abort-skip.
  `tsc` clean, **947 pass / 0 fail** (941 + 6); non-vacuous (no-sweep TDD-proofed). **This repo
  is NOT opted in** (capability shipped only); the manual smoke is the human's final check.
  **Ticket 09** (cross-worktree project-tag coherence) is also shipped (`78280040`: a repo-local
  `projectName` override stabilizes the tag across all worktrees of one repo; TDD, 950 pass).
  **All parent-effort tickets (01–09) are closed → the effort is COMPLETE** (destination reached
  + coherence enhancement). This repo is not opted in to autocommit/projectName — capability
  shipped only.
- **Domain.** pi `hermes-memory` extension (project-memory markdown SoT + DB index), pi
  lifecycle hooks, and this repo's git/worktree flow.
- **Skills every session should consult:** wayfinder (this map), grilling,
  domain-modeling, test-driven-development (06/08), systematic-debugging (06),
  verification-before-completion (08).
- **Standing preference:** written artifacts in English; conversation per the live
  `responseLanguage` setting.
- **Chart-time facts (ground the tickets):**
  - SoT relocated `.planning/memory/` → `.agents/memory/MEMORY.md` (PR #985); the file is
    **git-tracked, not gitignored** — a valid commit target.
  - hermes-memory lifecycle hooks present: `session_start`, `before_agent_start`,
    `message_end`, `session_shutdown` (commit-trigger candidates).
  - **Git-commit precedent exists**: `pi-agent-ext-subagent/src/git-scope.ts` and
    `superpowers.ts` already run `git` — a helper to reuse, not invent.
  - **Opt-in env-var pattern precedent**: `PI_PLANNING_EFFORT`, `PI_HERMES_CONSOLIDATING`,
    `PI_MEMORY_FILE_LOCK` — a `PI_MEMORY_AUTOCOMMIT`-style knob fits.
  - A **consolidation flow** exists (`PI_HERMES_CONSOLIDATING`) that rewrites MEMORY.md —
    a potential sequencing conflict with auto-commit (see Not-yet-specified F1).

## Decisions so far

- [Opt-in contract & config knob](tickets/01-opt-in-contract-and-config-knob.md) — **per-repo** opt-in via a **narrow-overlay** repo-local config flag `autoCommitProjectMemory` at `.agents/memory/config.json`; project-memory keys only, merged over the global config (DB/backend settings stay global). No-op + warn when opted-in but `projectMemoryDir=null`; discovered via the existing `resolveProjectStoreDir` (worktree-anchored).
- [Index/round-trip coherence research](tickets/07-index-roundtrip-coherence-research.md) — **no drift; the hook need NOT re-sync.** Startup `syncMarkdownMemories` (idempotent upsert, reads MEMORY.md fresh) re-indexes a committed file on the next session start in any worktree; drift is at most intra-session, closable via `/memory-sync-markdown`. Cleared fog F4 (revert + auto re-sync = no DB rollback). Side-finding → ticket 09 (cross-worktree project-tag divergence).
- [Trigger event & batch granularity](tickets/02-trigger-event-and-batch-granularity.md) — **`message_end` + ~20s trailing debounce, one commit per burst.** Writes are on disk by message_end (synchronous) — no memory is ever lost on crash, only the commit is delayed; residual risk = worktree-discard within ~20s. Chosen over session_shutdown (races the fire-and-forget flush), a new memory:written event (heaviest build), and goal completion (exclusionary). Consolidation-defer absorbs fog F1 into ticket 04.
- [Commit content & message contract](tickets/03-commit-content-and-message-contract.md) — **stage `.agents/memory/MEMORY.md` only** (explicit path, never `-A`; `config.json` committed separately; global DB out of reach; unchanged→no-op via 02's gate). Message: fixed **`docs(memory): auto-update project memory`** (matches the repo's `docs(memory):` content-commit scope).
- [Commit safety / abort conditions](tickets/04-commit-safety-and-abort-conditions.md) — **best-effort guard set, no hard errors** (never-throws contract). Skip+log on unsafe git states (non-repo, mid-rebase/merge, detached HEAD); defer+re-arm on transient contention (consolidation, file/git-index lock, commit failure); proceed on dirty-tree (stage MEMORY.md only, never `-A`, per 03). **Untracked MEMORY.md → auto-track + commit** (gitignored → skip+warn). Retry = re-arm debounce; resolves next message_end; session-end defers to next session.
- [Worktree/branch topology & conflict strategy](tickets/05-worktree-topology-and-conflict-strategy.md) — **custom §-union merge driver** (split on §, union-by-content dedup; `.gitattributes merge=pi-memory` + hook self-configures the per-clone git-config driver). Conflicts are frequent (both efforts append at end → forward-merge collides every time), so manual/LWW rejected (LWW loses memory). Topology: commit on current branch, **suppress on protected/main**; cross-worktree sharing is post-merge (next session's sync). Clears fog F2.
- [Cross-worktree project-tag coherence](tickets/09-cross-worktree-project-tag-coherence.md) — **in-scope: repo-local `projectName` override.** A `projectName` key in `.agents/memory/config.json` overrides `path.basename(cwd)` in `detectProject` (one committed edit → all 8 worktrees of a repo share one tag); keeps `detectProject` pure (no git lookup); `index.ts:131` is the single tag source, so `syncMarkdownMemories` inherits it. Shipped (`78280040`, TDD, 950 pass). Migration: old basename-tagged rows are orphans until consolidation (cosmetic).

## Not yet specified

- **F1 — Auto-commit vs consolidation sequencing.** ✅ Resolved by ticket 02: the debounce commit defers (reschedules) while MEMORY.md is under write/consolidation — a guard absorbed by ticket 04's abort set. No longer fog.
- **F2 — Severity of concurrent multi-worktree writes.** ✅ Resolved by ticket 05: conflicts are the DEFAULT (append-at-end pattern → forward-merge collides every time), frequent enough to warrant the custom §-union merge driver. No longer fog.
- **F3 — Commit author/identity.** ✅ Resolved by ticket 06's build: the commit uses no
  `--author` flag → defaults to the current git user config (no special bot identity).
- **F4 — Undo/rollback story.** ✅ Resolved by ticket 07: `git revert` is the whole story — the next startup `syncMarkdownMemories` re-derives the DB from the reverted MEMORY.md (idempotent upsert); no paired DB rollback needed.

## Out of scope

- The **global store** (`user`, global `memory`, `failure` under `~/.pi/agent`) — stays
  global, never in this repo.
- **Other agent-written repo files** (`.planning/` artifacts) — this effort is MEMORY.md
  only.
- **Changing the §-delimited `MEMORY.md` format** (kept for round-trip with the global
  store).
- **Changing the project-vs-global memory split** (settled by persistent-to-planning + the
  2026-08-01 relocation).
