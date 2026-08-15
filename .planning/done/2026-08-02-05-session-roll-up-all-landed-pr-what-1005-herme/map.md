---
status: complete
---

# Wayfinder map: per-session assembly log (prompt-provenance) — UPSP §5, DO ticket 05

> Origin: the UPSP study effort (`2026-08-02-try-to-checkout-code-use-gh-and-learning-from-ht`,
> ticket `05-do-session-assembly-log.md`). This is the next backlog item after the landed
> roll-up PRs (#1005 pin-field, #1006 wayfind manifest, #1007 dangling-ref sweep,
> #1009 numeric isolation, #1010 await_pr_merge hardening).

## Destination

> ✅ **Reached** — PR [#1012](https://github.com/ziyu4huang/video_generation/pull/1012) merged (2026-08-02). Built via spec → plan → SDD (7 tasks, all review-clean, 1062 tests green). Deferred follow-ups tracked in `sdd/plan/progress.md`.

hermes-memory records, **once per session at `session_start`**, the **prompt-provenance**
of the memory block it injects: the set of `md_id`s assembled across all injected blocks
(global memory + global user + post-filter active-failures + project memory) plus a
SHA-256 of the rendered block. Stored in a new normalized `session_assembly(session_id,
md_id)` table (+ `assembly_hash` on `sessions`), on **both** SQLite and Surreal backends.
This is the **cheap tier** only — the missing *prompt*-provenance half (we already have
*entry*-provenance). Queryable at the DB level: `SELECT DISTINCT session_id FROM
session_assembly WHERE md_id = ?` answers "which sessions saw memory M?"

## Notes

**No multi-ticket map was charted.** The chart-the-map grill (2026-08-02) cleared every
open decision in one pass — the work is a single S-effort feature with five inline design
choices, all now settled (see spec.md). Wayfinder step-3 rule applied: fog too thin for a
multi-ticket map. Proceeding via **spec.md → plan.md → SDD execute** (Superpowers path).

- **Domain:** `bun-apps/pi-agent-ext-hermes-memory/`. Skills every session should consult:
  `writing-plans`, `subagent-driven-development`, `verification-before-completion`.
- **Standing prefs:** both SQLite + Surreal backends must carry any schema change (parity is
  a hard constraint, not a nice-to-have). Match the house spec style (verified code sites
  with line numbers — see `2026-08-02-hermes-dangling-reference-sweep/spec.md`).
- **D1 hardening:** if a spec-reality pivot occurs during execution (a designed mechanism
  turns out to be a no-op against real data), document the pivot in the spec + commit
  message, as the sibling roll-up PRs did (#1007, #1009).

## Decisions so far

<!-- none via ticket — the five design decisions are recorded in spec.md §Design -->

## Not yet specified

<!-- fog graduates here as the frontier advances; currently clear -->

## Out of scope

Work consciously ruled out of **this** effort (reopens only as a fresh effort if the
destination is redrawn):

- **Query surface / TUI command** — "queryable" means the data exists & is joinable at the
  DB level (raw SurrealQL/SQL). No new `/memory-...` tool or command ships in this pass.
- **Replay / drift-detection harness** — UPSP's stronger tier (`replay_material_retention`
  analogue: re-assemble from a snapshot, assert byte/set equality vs a golden). Only worth
  it once decaying/consolidating memory can drift. DEFERRED.
- **#06 "used vs dropped" signal (UPSP §9 默契集)** — records which surfaced entries the
  agent's later actions referenced; spares `used` entries from decay. Depends on this
  ticket (it joins on the assembly log) but is its own effort.
- **Destructive-supersede audit-row smell** — §5 flags that `offloaded_superseded` purges
  with NO lineage/audit row (the "receipt" gap). Closing it rides with a separate
  supersession-provenance effort, not here.
- **Per-run capture** — capturing every `before_agent_start` assembly (to reflect
  mid-session memory-tool mutations entering the prompt). Rejected: mid-session writes are
  already audited by the memory tool's own `added_md_id`/lineage, so per-session-at-start
  covers "did S see M?" = loaded-at-start ∪ written-during-S.
> Closed 2026-08-15: map records ✅ Reached (PR #1012, 7 SDD tasks).
