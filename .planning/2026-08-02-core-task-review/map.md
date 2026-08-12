# Wayfinder map: 2026-08-02-core-task-review

## Destination

A prioritized **findings doc → tickets** for `bun-apps/pi-agent-ext-core-task`, covering all four review areas — GLA subsystem (goal/auditor/reviewer) · Todos · Co-work with wayfind/superpowers · Doc/contract drift. Full findings in [`findings.md`](./findings.md) (6 HIGH / 12 MED / 15 LOW, every item cited to `file:line`). Grilling decision: **todos stay ephemeral** (no durability bridge). All five groupings (A–E) accepted → **14 tickets**. This effort is **review + ticketing only**; executing the tickets is out of scope.

## Notes

**Base**: detached HEAD `2244b509` (origin/main has since advanced to `a32870d9`, #1000 hermes-memory — does not touch core-task).

**Method**: 4 parallel read-only subagents (one per area), evidence cited to `file:line`; synthesized into `findings.md`.

**Tickets** (group · title · findings · blocked-by):

| # | Group | Title | Findings | Blocked by |
|---|-------|-------|----------|------------|
| 01 | A | Decide & implement the wayfind↔goal/loop mutual-yield | H1, M9 | — |
| 02 | A | Harden the seam-contract "NO DEAD KEYS" test | H2 | **01** |
| 03 | B | Reviewer config surface (`/glla` strings + mode + auto/aggressive tests) | H3, L2 | — |
| 04 | B | Reviewer data-loss on confirm-throw-after-enqueue | M1 | — |
| 05 | B | Reviewer FP anti-patterns | M2 | — |
| 06 | B | `regression_shield` activation (activate or mark inert) | M3 | — |
| 07 | C | Auditor `modelRuntime` defensive guard + CI contract test | H4 | — |
| 08 | D | Confirm pi process-per-session (todo store concurrency) | H5 | — |
| 09 | D | Todo render correctness + overlay/envelope test suite (TDD) | M4, M6, M8 | — |
| 10 | D | Todo delete referential integrity (prune `blockedBy`) | M5, L9 | — |
| 11 | D | Todo schema/reducer drift | M7, L11 | — |
| 12 | E | Doc accuracy sweep (above→below ×10 + CONTEXT `/loop`,`/list`,widget inventory) | H6, M12, L13 | — |
| 13 | E | Dead-code + provenance cleanup | L3, L14, L15 | — |
| 14 | — | LOW cleanup backlog (batch) | LOWs | — |
| 15 | — | Next-ticket routing / ask-user gap | P1 | — |
| 16 | D | Key session-scoped core-task state by sessionId (in-process subagent cross-contamination) | H5 | 08 |

**Dependency graph**: one hard edge — `01 → 02` (contract-test hardening must match whichever direction the yield decision lands). All other tickets parallelize. Soft coordination: 01/12/13 all touch coordination prose — sequence to avoid churn; 09's test harness can be leaned on by 10/11 (not hard-blocked).

**Suggested execution order** (highest-leverage first): `01 → 07 → 04+09 → 03 → 10,11 → 12,13 → 05,06,08,14`, 15 (process, action when convenient), 16 (follow-up, spawned by 08).

## Decisions so far

- [01 — Decide & implement the wayfind↔goal/loop mutual-yield](tickets/01-fix-coordination-fiction-yield.md) — **option (b) DELETE**: the `__piWayfindActive` coordination seam was removed (publish path + `SEAM_KEYS` entry dropped) and the ~6 stale doc sites corrected to "wayfind does not yield; mutual-exclusion is user-initiated." Shipped in #1051 (`0eee0ba9`), recorded as [ADR-0006 (Accepted)](../../bun-apps/pi-agent-ext-wayfind/docs/adr/0006-delete-wayfind-active-coordination-seam.md). Double-drive risk accepted as user-initiated.
- [02 — Harden the seam-contract "NO DEAD KEYS" test](tickets/02-harden-seam-contract-test.md) — **shipped**: the `findSelfOnlySeams` predicate now requires ≥2 distinct packages to reference a function-valued `__pi*Active` seam, closing the self-reference loophole. Shipped in #1053 (`56471a0c`).

## Not yet specified

- **06 — activate or mark?** Ship a `/goal --verify` contract flag (make auditor floor #5 live), or just comment it as inert-by-design?
- **08 — pi's process model?** Does pi guarantee one process per session? Determines whether the todo store needs session-keying.

## Out of scope

- A todos↔wayfind/superpowers durability bridge — settled (ephemeral by design).
- Executing the tickets — this effort produces the backlog; each ticket is its own follow-up.
- *(Design idea, not this effort)* Effort-level structured metadata / `map.md` front-matter for the wayfind extension — today `readMap` parses only `## Section` headings, so a YAML manifest block would be ignored; making it real is a wayfind-ext enhancement, not a per-effort bolt-on.
