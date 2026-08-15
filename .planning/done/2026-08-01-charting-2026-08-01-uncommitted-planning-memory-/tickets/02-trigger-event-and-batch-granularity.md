# 02 — Trigger event & batch granularity

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

Which pi **lifecycle event** fires the commit, and what is the **batch unit** (how many
writes land in one commit)? This is the durability-vs-noise dial: too eager → commit
spam; too lazy → edits lost if the session dies mid-flight.

## What to build

A grilled decision on the trigger. hermes-memory already hooks `session_start`,
`before_agent_start`, `message_end`, `session_shutdown`. Candidates:

- **`session_shutdown`** — one commit per session (coarsest; loses anything if the session
  crashes before shutdown).
- **`message_end` coalesced/debounced** — commit shortly after a burst of writes settles;
  fine-grained, survives crashes between turns, but needs a debounce window.
- **A new `memory:written` event** emitted by the write path — most precise (commit
  exactly when MEMORY.md changes), but requires wiring a new emit in the store.
- **Goal completion** (pairs with pi `/goal`) — commit when a goal closes; semantically
  tidy but couples memory durability to goal lifecycle (memory written outside a goal
  never commits).

## Acceptance

- [ ] Trigger event chosen + the batch/coalesce rule (e.g. "debounce 2s after last write,
      max one commit per turn").
- [ ] States the **crash window** — how much memory can be lost if the session dies, and
      whether that's acceptable.
- [ ] Weighs commit-noise vs durability explicitly; names the worst case for the choice.

## Resolution

**Decision (grilled 2026-08-01): commit on `message_end` with a trailing debounce,
one commit per burst (~20s).**

- **Trigger — `message_end` + debounce.** Mid-turn memory writes land on disk
  *synchronously* at the `memory`-tool call, so by `message_end` they are already
  persisted — the hook commits against a settled file. Chosen over:
  - **`session_shutdown`** — the session-flush (`session-flush.ts`) runs here
    fire-and-forget (≤10s, NOT awaited), so a commit would race it (fire before the
    flush's writes land); plus a crash before shutdown loses the whole session's commits.
  - **a new `memory:written` event** — most precise, but needs wiring a new emit into
    the core write path (heaviest build, touches shared code).
  - **goal completion** — exclusionary (memory saved outside a `/goal` never commits).
- **Batch — one commit per burst.** A ~20s trailing debounce: reset the timer on each
  `message_end` where MEMORY.md changed since the last commit; fire one commit when it
  expires. Coalesces a cluster of memory activity into a single commit (≈1 per cluster).
  The ~20s is a tunable default for ticket 06. Commit is skipped when MEMORY.md is
  unchanged since the last commit (the no-empty-commit gate from 03/04).
- **Crash window — effectively zero memory loss.** Writes hit disk at call time, so a
  session crash never loses memory — only the *commit* is delayed. The sole residual risk
  is worktree-discard within the ~20s debounce window (rare). Satisfies the crash-window
  acceptance with margin.

**Consolidation interaction (absorbs fog F1).** The debounce commit must defer
(reschedule) while MEMORY.md is under write — including the consolidation flow, which
rewrites MEMORY.md (`PI_HERMES_CONSOLIDATING`); committing mid-flight would capture a
half-consolidated file. This is a defer-and-reschedule guard that belongs to ticket 04's
abort set (already anticipated there) — the debounce simply re-arms to fire after the
write/consolidation settles. **F1 is therefore no longer fog**; it is resolved as "defer
during consolidation, part of 04."

**Downstream sharpening.** Ticket 06 now has a concrete trigger+batch spec (debounce
timer on `message_end`, changed-gate, defer-on-write). Ticket 04's consolidation-defer
guard is confirmed (F1). No new ticket graduated.
