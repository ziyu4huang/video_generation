# 03 — Commit content & message contract

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

**What exactly is staged and committed**, and what is the commit **message**? The hook
must never sweep unrelated work into a memory commit.

## What to build

A grilled decision on the commit payload + message. Candidates / constraints:

- **Files:** only `.agents/memory/MEMORY.md` (the project SoT). **Never** `git add -A` /
  `git add .` — must stage the explicit path. Decide whether any in-repo DB sidecar / index
  artifact also belongs (probably not — index is derived, regenerated on scan).
- **Message format:** conventional-commits `chore(memory): <one-line gist>`; or a fixed
  `chore(memory): update project memory`; or include a turn/goal id. Gist extraction is
  nice-to-have, not required.
- **Hard constraint:** the global store (`~/.pi/agent`) is **never** touched by this commit
  — confirm the hook cannot reach it.

## Acceptance

- [ ] Exact file set named (path-anchored staging, never `-A`).
- [ ] Message template chosen; states whether a gist/summary is extracted or the message
      is fixed.
- [ ] Confirms the global store is structurally out of reach of this commit.
- [ ] States behavior when MEMORY.md is **unchanged** since last commit (no-op commit
      skipped).

## Resolution

**Decision (grilled 2026-08-01): stage MEMORY.md only (path-anchored, never `-A`);
fixed message `docs(memory): auto-update project memory`.**

- **Staged file set — `.agents/memory/MEMORY.md` only.** Confirmed by fact:
  `.agents/memory/` contains only MEMORY.md (no in-repo DB sidecar — the index lives
  globally in `~/.pi/agent/pi-hermes-memory/`). The hook stages the **explicit path**, never
  `git add -A` / `.` — so unrelated dirty files in the worktree are never swept in.
- **`config.json` is NOT staged.** Ticket 01's repo-local config
  (`.agents/memory/config.json`) is hand-authored opt-in, committed once manually when the
  effort opts in — it is not memory content and is never touched by the autocommit (which
  fires on memory writes).
- **Global store structurally out of reach.** The DB (`sessions.db` / SurrealDB) is global
  under `~/.pi/agent`, outside the repo; the hook operates on the in-repo MEMORY.md path only.
- **Unchanged → no-op skip.** When MEMORY.md is unchanged since the last commit, the
  debounce changed-gate (ticket 02) skips — no empty commit.
- **Message — fixed `docs(memory): auto-update project memory`.** Matches the repo's
  `docs(memory):` scope already used for memory-content commits (e.g.
  `docs(memory): add 5b lineage model…`, `docs(memory): reconcile file2md PDF AB-test
  entries`); "auto-update" flags it as machine-generated. Chosen over a count-suffixed form
  (mild differentiation, extra diff work) and a full gist (best matches the descriptive
  precedent but fragile to parse). The diff body is the source of truth;
  `git log -p --grep="docs(memory)"` still greps the history.

**Downstream sharpening.** Ticket 06 now has the full commit contract (path-anchored
stage, fixed message, changed-gate). No fog graduated; no new ticket.
