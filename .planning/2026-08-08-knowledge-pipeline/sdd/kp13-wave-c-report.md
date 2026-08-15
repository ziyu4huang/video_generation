# kp13 Wave C — final report / handoff (zk-spawn implementer, 2026-08-15)

Branch: `feat/kp13-wave-c-tier1-retire` @ `152ae4f4` (pushed, WIP)
PR: https://github.com/ziyu4huang/video_generation/pull/1378 (open, NOT merged)
Worktree: `/tmp/kp13-wave-c` (untracked scratch noise left unstaged: bun.lock churn + mode-only devops file churn)

## State: implementation COMPLETE + package-green; blocked at pre-push ci-local gate (RED), pushed as WIP per task's failure-path allowance ("a WIP branch push still counts as safe"); `--no-verify` justified by that allowance, NOT the ADR-noise clause. Do NOT merge until the gate question is resolved.

## Pre-push gate failure (verbatim; also in PR body)

```
passed: 14   failed: 1   skipped: 0   of 15

FAILURES (1):
  - Workspace dist-freshness guard (blocks)   (log: /var/folders/r0/f18dr3wn6czf35q1xmktsjhm0000gn/T/ci-local.Oo5Hlm/Workspace-dist-freshness-guard-blocks-.log)

ci-local: FAIL
✗ pre-push blocked: a CI regression gate failed (see the output above).
---
- "all fresh"
+ "stale dist builds:
+   @repo/pi-agent-ext-superpowers: dist/ is MISSING — ( cd bun-apps/pi-agent-ext-superpowers && bun run build )
+   @repo/pi-agent-ext-webui: dist/ is MISSING — ( cd bun-apps/pi-agent-ext-webui && bun run build )
+   @repo/pi-agent-ext-wayfind: dist/ is MISSING — ( cd bun-apps/pi-agent-ext-wayfind && bun run build )"
```

Suspected cause (un-investigated per guardrails): fresh /tmp worktree carries no git-ignored `dist/`; the gate compares dist-entry packages' dist vs src. Likely resolution for the merger: run the three builds in the worktree, or re-run the gate from a normal clone/worktree — NOT a code defect of this PR (it touches none of those packages).

## Verification (package-scoped, green)

```
( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )  → clean (exit 0)
bun test → 1630 tests: 1629 pass / 0 fail / 1 skip
skip = md-id-schema.test.ts pre-existing hard-coded test.skip ("re-enabled/moved in Task 4"), untouched.
Surreal: server REACHABLE — kp13-acceptance surreal parity leg ran LIVE (isolated ns test_hermes_kp13c / db kp13_wave_c).
```

## What shipped in commit 152ae4f4 (17 files, +649/−182)

### Part 1 — Tier-1 memory walk mirror (`src/walk-and-ingest.ts`)
- New step 8d `mirrorMemoryToStore(memoryDir?)` + receipt field `memoryMirrored`.
- Files: MEMORY.md→kind `memory`, USER.md→`user`, failures.md→`failure` (GLOBAL files at the fixed memory-dir location; in-repo `.agents/memory` stays walk-deferred → ticket 21).
- Parse: `splitMemoryEntries` → `parseMarkdownMemoryEntry` (same parse as sync-markdown startup) → `mirrorMemoryEntry`.
- Hash-compare mechanism: **in-memory identity compare** (getCard → content+envelope equality → insert/update/skip), NOT planning's `card_md_hash` (SQLITE_ONLY on the CardPersistence seam, Wave A decision) — documented in the docstring. Backend-agnostic primitive; walk opens the same short-lived sqlite `createCardStore({memoryDir})` as planning/knowledge mirrors.
- Gating: UNCONDITIONAL (no new knob) like planning — fixed location, ≤3 files, idempotent, no cost concern; runs in `planningOnly` mode so session-start planning backfill doubles as the Tier-1 re-index trigger for direct md edits. `ok:false` receipt still reports `memoryMirrored` truthfully.

### Part 2 — legacy deletion (grep-proven zero references)
Deleted:
- `syncEvictionsFromSqlite` + inline transfer `removeByMdId` loop (memory-tool.ts)
- `syncEvictions` + `sqliteProjectFor` ×2 (review-memory-ops.ts, memory-tool.ts)
- dead `memoryRepo` threading: `registerMemoryTool(pi, store, projectStore, projectName, cardStore)`, `applyReviewOperations(store, projectStore, ops, projectName, cardStore)`, `runDirectBackgroundReview(..., projectName, cardStore)`, `BackgroundReviewOptions.memoryRepo` removed; `index.ts` wiring updated.
Replacement: `mirrorMemoryEvictions(cardStore, mdIds)` in `src/store/memory-card-mirror.ts` — `deleteCard` by globally-unique md_id (Card.id == memories.md_id), per-id best-effort.
Kept per ticket: `syncMemoryEntry`/`replaceSyncedMemories`/`removeSyncedMemories`/`removeByMdId` on the MemoryRepository interface (sessions + non-memory + ticket 21).
Gate proof (all zero in src): `syncEvictionsFromSqlite` / `async function syncEvictions` / `sqliteProjectFor` in writer files / live `.removeByMdId(|.syncMemoryEntry(|…` in the 10 writer files / code `memoryRepo` refs in memory-tool+review-memory-ops.
Sole-source gate (`tests/store/memory-mirror-sole-source.test.ts`) extended: LIVE_CALL now includes `removeByMdId` (the plan's "legacy path deleted (grep test)").

Test migrations (signature-driven only, no assertion weakening):
- tests/tools/memory-tool.test.ts (25 pass) — arg shuffles
- tests/handlers/review-memory-ops.test.ts, sync-markdown-memories.test.ts, overflow-superseded-sync.test.ts (joined `createCardStore({memoryDir, sqliteBackend})` where eviction path needs a store)
- tests/integration/id-lifecycle.test.ts + birth-md-id.test.ts — adapter mirrors updated to the NEW production adapter (mirrorMemoryEvictions/mirrorMemoryAdd via joined card store)
- tests/perf/schema-cost.regression.test.ts, tests/stealth-trim.test.ts — arg shuffle

### Part 3 — acceptance harness + ticket stamp
- `tests/kp13-acceptance.test.ts` (4/4 pass): bullet 1 (3-kind §-entry round-trip no-content-loss + idempotent re-walk→0), bullet 3 (knowledge+memory edits through ONE walkAndIngest; memory leg asserts md-wins UPDATE in place with stable id; knowledge leg asserts insert-idempotence/no-dup — per-card knowledge UPDATE is ticket-05 scope, documented), bullet 2 (thin dual-backend parity: upsert/dedup/getCard/getCardsByKind/updateCard/deleteCard on sqlite + surreal LIVE leg, graceful skip w/ logged status when server down), bullet 4 = the package suite itself.
- Ticket 13: 4 acceptance checkboxes → `[x]`; Wave status appended: "**C SHIPPED (this PR, 2026-08-15)**: Tier-1 memory walk mirror (md-wins hash/identity compare); legacy dormant mirror helpers deleted; acceptance harness added. Ticket 13 COMPLETE pending review+merge."

## Known deviations / handoff notes
1. ci-local gate RED as above — unresolved by design (guardrails); WIP push.
2. `map.md` "13 SHIPPED" stamp NOT applied — hard guardrail limited writes to hermes-memory + the one ticket file. Merger should stamp `.planning/2026-08-08-knowledge-pipeline/map.md` (and tick ticket 13 status/headers) at merge time.
3. Bullet-3 knowledge-edit leg scoped honestly (idempotence, not in-place update) — rationale in harness header.
4. Untracked noise in worktree left unstaged: `bun-apps/bun.lock` (+5 lines, from `bun install`), mode-only 100644→100755 churn on 5 devops cli files (checkout artifact). Do NOT commit these with this PR.
5. After merge: `git worktree remove /tmp/kp13-wave-c` + branch sweep.
