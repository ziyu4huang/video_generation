# 04 — Commit safety / abort conditions

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

**When must the hook refrain from committing?** Autonomous `git commit` is safe only with a
guard set that refuses to act in dangerous tree states. This ticket names that guard set.

## What to build

A grilled decision enumerating the abort conditions and the behavior on each (skip + log vs
defer + retry vs hard error). Conditions to decide:

- **Other uncommitted changes** in the tree → must stage **only** MEMORY.md (never `-A`);
  confirm the hook can commit MEMORY.md while unrelated files stay dirty.
- **Worktree mid-rebase / merge / cherry-pick** (`.git/MERGE_HEAD`, `rebase-merge/`, etc.)
  → skip.
- **Consolidation in flight** (`PI_HERMES_CONSOLIDATING`) → defer-and-reschedule until
  it settles (confirmed by ticket 02; F1 resolved).
- **File lock held** (`PI_MEMORY_FILE_LOCK`) → defer; a write is in progress.
- **Detached HEAD / not a git repo / `.agents/memory/MEMORY.md` untracked here** → skip +
  log.
- **Nothing staged after path-filter** (MEMORY.md unchanged) → no-op skip.

## Acceptance

- [ ] Full abort-condition set enumerated, each with its behavior (skip-log / defer-retry /
      error).
- [ ] Confirms the hook stages the explicit MEMORY.md path even when the tree is otherwise
      dirty (the "no `-A`" guarantee).
- [ ] States a retry/backoff policy for the defer-and-retry cases (e.g. retry once on next
      hook fire).

## Resolution

**Decision (grilled 2026-08-01): a best-effort guard set — skip-and-log on unsafe git
states, defer-and-rearm on transient contention, auto-track on first encounter. No hard
errors (git ops follow the `git-scope.ts` never-throws contract).**

**Guard set + behavior:**

| Condition | Behavior |
|---|---|
| MEMORY.md unchanged since last commit | no-op SKIP (02's changed-gate) |
| Not a git repo | SKIP + log |
| Mid-rebase / merge / cherry-pick (`.git/MERGE_HEAD`, `rebase-merge/`, …) | SKIP + log (unsafe to commit mid-op) |
| Detached HEAD | SKIP + log (commit would be orphaned/lost) |
| Consolidation in flight (`PI_HERMES_CONSOLIDATING`) | DEFER → re-arm (02 / F1) |
| Memory file lock held (`PI_MEMORY_FILE_LOCK`) | DEFER → re-arm (write in progress) |
| Git index lock / `git commit` transient failure | best-effort SWALLOW → re-arm next message_end (never-throws contract) |
| Other dirty files in the tree | PROCEED — stage only MEMORY.md, never `-A` (03) |
| MEMORY.md untracked + NOT gitignored | AUTO-TRACK (`git add .agents/memory/MEMORY.md`) + commit |
| MEMORY.md untracked + gitignored | SKIP + warn (don't force-add against an explicit exclude) |

**Untracked MEMORY.md — AUTO-TRACK + commit** (the one grilled fork). `git add` on first
encounter, then commit — self-bootstrapping and consistent with opt-in (opting into
autocommit implies wanting memory tracked). Guarded: if MEMORY.md is gitignored, skip + warn
(never force-add an explicit exclude). In this repo it's a no-op (already tracked, PR #985).

**Error behavior — no hard errors.** Git ops are best-effort and swallow failures (matching
`git-scope.ts`'s never-throws contract); a failed commit simply doesn't land this cycle.

**Retry / backoff policy.** DEFER = re-arm the ~20s debounce (02); the commit resolves on the
next eligible `message_end` after the condition clears (consolidation done, lock released,
git idle). No explicit retry loop or cap — the debounce + next-turn naturally resolve it. If
the session ends with a defer pending, the commit lands on the NEXT session's first
`message_end` (memory is already on disk — not lost).

**No-`-A` guarantee (acceptance #2).** Confirmed: the hook stages the explicit MEMORY.md
path only, so unrelated dirty files stay dirty while MEMORY.md commits cleanly. (Note: the
hook commits the *current* MEMORY.md state regardless of what changed it — a hand-edit to
MEMORY.md rides along; acceptable and rare.)

**Downstream.** Ticket 06 now has the complete guard spec; after 05 closes, 06 is fully
unblocked. No fog graduated; no new ticket.
