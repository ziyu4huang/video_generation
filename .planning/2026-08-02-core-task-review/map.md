---
effort: 2026-08-02-core-task-review
status: complete
last: 2026-08-12
---

# Wayfinder map: 2026-08-02-core-task-review

## Effort complete

> **Status: COMPLETE ✅ (2026-08-12)** — all 14 code tickets (01–14 + 16) shipped across PRs #1051, #1053, #1058–#1075, #1133, #1135 and are now closed in tracking. Ticket 15 (next-ticket routing / ask-user gap) stays open as a process note, orthogonal to the code backlog. **One residual:** ticket 16's `goalState` stage-4 session isolation is deferred to the sibling effort `2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task` (ticket 03, stage 4) — the todo store + loopState are already keyed by sessionId (#1133, #1135). This is an **additive closeout** — the `## Decisions so far` entries are extended with 03–14/16, the prior 01/02 entries are preserved, and `## Not yet specified` is emptied (06 and 08 are now decided: 06 inert-by-design, 08 process-per-session).

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
- [03 — Reviewer config surface](tickets/03-reviewer-config-surface.md) — **shipped**: `/goal review on|off|auto|aggressive` parse surfaced; `/glla` strings removed; reviewer mode settable. Shipped in #1063.
- [04 — Reviewer data-loss on confirm-throw-after-enqueue](tickets/04-reviewer-data-loss-confirm-throw.md) — **shipped**: `reviewerEnqueued` hoisted pre-try; the catch preserves the queue (`preserveList`), so a confirm-throw no longer drops the reviewer list. Shipped in #1059.
- [05 — Reviewer false-positive anti-patterns](tickets/05-reviewer-false-positive-antipatterns.md) — **shipped**: anti-pattern regexes tightened (`\bno issues\b`, "improvements" wording) to cut false positives. Shipped in #1071.
- [06 — `regression_shield` activation](tickets/06-regression-shield-activation.md) — **shipped (option b, inert-by-design)**: auditor floor #5 (`regression_shield`) marked inert; no `--verify` flag added. Shipped in #1072.
- [07 — Auditor `modelRuntime` defensive guard + CI contract test](tickets/07-auditor-modelruntime-hardening.md) — **shipped**: `extractModelRuntime` defensive guard + contract test. Shipped in #1058.
- [08 — Confirm pi process-per-session](tickets/08-confirm-pi-process-per-session.md) — **shipped**: confirmed pi runs one process per session (documented); todo store re-keyed per sessionId. Shipped in #1075 + #1133.
- [09 — Todo render correctness + overlay/envelope test suite](tickets/09-todo-render-correctness-tests.md) — **shipped**: error glyph ✗; all-done panel; overlay + response-envelope TDD suites. Shipped in #1061.
- [10 — Todo delete referential integrity](tickets/10-todo-delete-referential-integrity.md) — **shipped**: delete prunes `blockedBy` + referential-integrity check. Shipped in #1064.
- [11 — Todo schema/reducer drift](tickets/11-todo-schema-reducer-drift.md) — **shipped**: action-conditional schema + explicit reducer errors. Shipped in #1065.
- [12 — Doc accuracy sweep](tickets/12-doc-accuracy-sweep.md) — **shipped**: doc sweep (`above-editor`→`belowEditor`; CONTEXT `/loop`,`/list` coverage). Shipped in #1067.
- [13 — Dead-code + provenance cleanup](tickets/13-deadcode-provenance-cleanup.md) — **shipped**: `replay.ts` + test deleted; provenance fixed; typo fixed. Shipped in #1068.
- [14 — LOW cleanup backlog (batch)](tickets/14-low-backlog.md) — **shipped**: LOW batch (EMPTY_STATE freeze; heartbeat cleanup; +6). Shipped in #1074.
- [16 — Key session-scoped core-task state by sessionId](tickets/16-key-session-state-by-sessionid.md) — **shipped (partial)**: todo store + loopState keyed by sessionId (#1133, #1135). **Residual:** `goalState` stage-4 isolation deferred → sibling effort `2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task` ticket 03 stage 4.

## Not yet specified

_(None open — 06 and 08 are now decided: 06 = inert-by-design, 08 = process-per-session.)_

## Out of scope

- A todos↔wayfind/superpowers durability bridge — settled (ephemeral by design).
- Executing the tickets — this effort produces the backlog; each ticket is its own follow-up.
- *(Design idea, not this effort)* Effort-level structured metadata / `map.md` front-matter for the wayfind extension — today `readMap` parses only `## Section` headings, so a YAML manifest block would be ignored; making it real is a wayfind-ext enhancement, not a per-effort bolt-on.
