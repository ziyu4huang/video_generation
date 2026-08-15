# 07 — Index / round-trip coherence research

---
type: research
status: closed
claimed: wayfinder-session
---

## Question

After a committed `.agents/memory/MEMORY.md` is **checked out in another worktree** (or
after an effort branch merges to main), does the DB re-index correctly so
`memory_search` returns the newly-committed entries — or is there **drift** between the
committed markdown SoT and the SurrealDB/SQLite index? Must the hook trigger a re-sync?

## What to build

A research pass (read-only) over the hermes-memory code: trace `sync-markdown-memories`
(the in-repo second-source scan shipped by persistent-to-planning) — when does it run
(session start? on-demand?), what does it scan, does it pick up externally-committed
changes to `.agents/memory/MEMORY.md`, and does it upsert vs duplicate. Report:

- The drift surface: scenarios where committed MEMORY.md and the DB diverge.
- Whether the autocommit hook (ticket 06) must emit a re-sync, or whether the existing scan
  already closes the loop.
- Any mitigation → graduate as a fresh ticket if needed.

Resolve via a read-only subagent / code-reading pass (this is local, not web — no
`web_search` needed unless external docs are required).

## Acceptance

- [ ] Findings recorded as the Resolution: how/when the DB re-syncs from committed MEMORY.md.
- [ ] Drift risk stated (yes/no + the scenario), with a citation to the sync code.
- [ ] If drift exists, a graduated ticket is created (and noted on this ticket + the map's
      Decisions-so-far).

## Resolution

**Research pass (read-only code trace, 2026-08-01). Core answer: no drift; the hook need
NOT trigger a re-sync.**

**Self-healing startup sync.** `syncMarkdownMemories` (`handlers/sync-markdown-memories.ts`)
runs at extension init for every normal session (`index.ts:192`, gated by
`shouldRunStartupSync()` — true unless a consolidation child). It reads the *current*
`<cwd>/.agents/memory/MEMORY.md` fresh (`readFileSync` at call time) and passes it as
`inRepoProjectFile` into the global DB. So a committed MEMORY.md checked out in another
worktree is **re-indexed on the next session start in that worktree**.

**Idempotent / dedup-safe.** `buildExistingIndex` fetches all stored memories once and keys
them by `target|project|category|content`; `mergeIsNoOp` skips no-ops;
`syncMemoryEntriesBatch` upserts (inserted vs skipped-as-duplicate). Re-syncing the same
committed MEMORY.md does NOT duplicate (the `/memory-sync-markdown` output states this
verbatim). The DB is **global / per-user** (`~/.pi/agent/pi-hermes-memory/sessions.db`, or
SurrealDB under a per-user namespace) — shared across all repos/worktrees, so a re-sync
from any worktree updates the shared index.

**Net: drift is transient and self-healing** — at most an intra-session staleness window
(between a mid-session `git checkout/merge` and the next session start), closable on
demand with `/memory-sync-markdown`. Ticket 06's hook does NOT need to emit a re-sync for
correctness; it only needs to land MEMORY.md in git — the startup sync + idempotent upsert
do the rest. This also **clears map fog F4**: a bad memory write that's auto-committed is
reverted via `git revert`, and the next startup sync re-derives the DB from the reverted
file — no paired DB rollback needed.

**Side-finding → graduated ticket 09 (cross-worktree project-tag divergence).** The in-repo
project memory is tagged with `project.name = path.basename(cwd)` (`detectProject`,
`project.ts`). `git worktree list` shows this repo's 8 worktrees have **8 different
basenames** (`video_generation`, `video_generation__superpowers`, `__archify`, …). So the
SAME committed MEMORY.md, synced from different worktrees, lands under **different project
tags** in the shared DB — and the dedup key *includes* `project`, so it does NOT dedupe
across them → the same content is indexed under up to 8 project names. **Pre-existing**
(detectProject behavior), NOT introduced by auto-commit — but auto-commit **amplifies** it
by making cross-worktree MEMORY.md sharing routine. Scope-status for this effort is itself
open → see ticket 09.

**Citations.** `handlers/sync-markdown-memories.ts` (syncMarkdownMemories,
buildExistingIndex, mergeIsNoOp, syncMemoryEntriesBatch); `index.ts:120-194`
(projectStoreDir, inRepoProjectFile, startup sync); `project.ts` (detectProject basename,
resolveProjectStoreDir); `config.ts` (shouldRunStartupSync / isConsolidatingChild).
