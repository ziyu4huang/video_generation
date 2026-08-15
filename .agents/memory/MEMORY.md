---
id: b896eb49-99c6-4d0c-ae98-f446801da1b2
created: 2026-08-14
last: 2026-08-15
---
RunView + AgentRow architecture — pinned decisions: home = core-runtime (both packages already depend, no new edges); RunView = immutable read-only derived projection, Variant A 'fat projection record' (all presentation incl. frozen elapsed resolved at BUILD time); status vocabulary unified on ActivityStatus 9-value union (queued|running|done|error|failed|skipped|timedout|budget|aborted — NO 'completed' member) with markCompleted gaining terminal param + new markFailed (closes 'failed children leave no terminal record' gap); glyphFor = single glyph source; registry derived reads as methods over internal pure functions; explicit updateTaskPreview write seam (workflow-manager stops poking entry.taskPreview); FULL destructive convergence of InFlightSubagent public surface → RunView; recorded in core-runtime/CONTEXT.md + ADR-0001 (docs/adr/0001-runview-destructive-convergence). Phase 2 (workflow-side migration + TUI subagents section rendering RunViews) shipped on main via PRs #1410–#1412.
§
---
id: 749ef2b2-5347-4a57-909c-e78e11025375
created: 2026-08-14
last: 2026-08-15
---
When a repo gate fails on a docs-only/unrelated PR, suspect pre-existing main drift FIRST — verify against clean origin/main before touching your own change; if a --no-verify bypass is unavoidable, log it explicitly in the PR description and flag it for a dedicated fix round.
§
---
id: 7738820c-39ed-408b-b593-c22084266b13
created: 2026-08-14
last: 2026-08-15
---
C1 codec unification closed via PR #1343 (splitPlanningFrontmatter rewired to the splitFencedYaml leaf in frontmatter-codec.ts, plus sole-source regression gate frontmatter-codec-sole-source.test.ts). DURABLE LESSON: architecture-review recommendations go stale fast in this repo — re-scan residual scope against current HEAD before executing review candidates; duplicate implementations re-emerge organically even after a canonical leaf exists, so ship a grep/sole-source gate test with every consolidation.
§
---
id: dc2ec7a8-51ad-4acd-8324-7ba9e0bfd18b
created: 2026-08-14
last: 2026-08-15
---
Wayfind package layout: there is NO self-named skills/wayfind/SKILL.md — the wayfinder process lives in procedures/wayfinder.md, the grilling discipline in skills/grilling/SKILL.md, and ~22 SKILL.md files exist under bun-apps/pi-agent-ext-wayfind/skills/.
§
---
id: f2baa43e-06b3-46ca-b258-c2b3b25fd9f6
created: 2026-08-14
last: 2026-08-15
---
DevOps unification — durable lessons NOT covered by CLAUDE.md: (1) port-then-delete rule — once logic is ported into a pi extension, the standalone script MUST be deleted (canonical engines live in extensions; copies are not canonical); (2) import-depth pitfall when relocating directory trees — files in scripts/lib/ needed ../../../pi-agent/... while scripts/deploy.ts needed ../../pi-agent/... for manifest.json; verify all relative imports after moving trees; (3) deploy.ts cwd-guard lesson — tests must spawn deploy.ts with cwd=pi-agent (the guard requires running from the pi-agent package directory) while keeping the DEPLOY path script-relative.
§
---
id: 540be258-dc14-4f67-953b-bfeee8951acb
created: 2026-08-15
last: 2026-08-15
---
Subagent token-budget + dispatch guardrails (root cause = model-side exploration/looping, NOT constraints alone; 13+ dispatches died at 300k–1.2M tokens): (1) pre-extract exact APIs/patterns via cheap researcher + inline near-complete spec — open-ended prompts burn entire budgets; (2) cap verbose command output; (3) SINGLE-SHOT dispatch mode (one command per subagent) is the only reliably surviving shape; (4) stop-before-commit — implementer does write+verify then STOPS, orchestrator ships via single-shot runners; (5) split multi-package tasks per child; (6) salvage beats re-dispatch — finisher = verify → commit → push, ≤3 fix cycles, WIP-push if red; (7) COMMIT-BEFORE-REPORT — commit + push to branch FIRST, then write report; (8) ABSOLUTE ban on `git reset --hard` in child dispatches — soft reset + selective restore instead (hard reset destroyed another session's MEMORY.md); (9) after zero-output death, re-dispatch SPLIT IN HALF per child; (10) salvagers/finishers self-merged ahead of reviewer gate — plan post-hoc review as norm; (11) after EVERY abort inspect git state first — work is often complete-but-uncommitted; (12) subagent reports echoing commands WITHOUT outputs are untrustworthy — re-verify git/PR state with fresh commands; quirk: preflight rejects tasks missing required tools — add them to 'tools' explicitly. Budget seam lived at subagent-tool-run.ts / subagents-tool.ts spawn args as of PR #1334 — re-locate after the #1340 barrel slimming.
§
---
id: fd401c04-84e1-4f2f-99e1-decc2fa5dec4
created: 2026-08-15
last: 2026-08-15
---
Planning-effort hygiene sweep rules: after any sibling mass-archive/sweep, verify still-active efforts weren't swept (a mass-sweep once archived a still-active effort and needed a rescue PR); plain-pi sessions lack extension tools (no wayfind_effort) — enumerate .planning/ via the filesystem, listing bare dirs too (many efforts have no map.md), not only map.md-bearing ones.
§
---
id: 4806129f-69c5-4a47-a691-83a3d7033604
created: 2026-08-15
last: 2026-08-15
---
Worktree topology (video_generation repo): `main` is checked out in the PRIMARY worktree at /Users/huangziyu/proj/video_generation — secondary worktrees must operate on detached HEAD (git checkout main → fatal 'main is already used by worktree'); after squash-merge the remote branch is deleted but a leftover local branch is harmless. Sibling sessions run in parallel and move origin/main mid-session — always re-fetch and list sibling PRs before branching/rebasing, and check file overlap of open sibling PRs before dispatching into the same area.
§
---
id: dfdd1bf5-2d65-4a87-9dad-fcb9e860212c
created: 2026-08-15
last: 2026-08-15
---
kp ticket 13 — memory-card graduation architecture (shipped 2026-08-15, waves A/B/C = PRs #1363/#1372/#1378): dual-backend card-store keyed by md_id forming the markdown↔DB mirror; Surreal delegates to SurrealMemoryRepository behind the CardPersistence seam (C6 dedup rides free); card-store joins BackendBundle (hot-swap covers cards); lazy re-migration on startup re-mirrors §-entries keyed by md_id; Tier-1 drift detection shipped in 13 (Tier-2/3 deferred to ticket 21); legacy content-key bridge retired (DELETE legacy mirror at end). SurrealDB-vs-SQLite decision (Surreal = primary CRUD+vector backend; SQLite fallback for non-vector CRUD+FTS5) recorded canonically in hermes-memory PRD.md + kp tickets/04.
§
---
id: 68c5150a-c54e-4707-a98b-6c350b32503b
created: 2026-08-15
last: 2026-08-15
---
[insight] Mass dirty-tree before sync = mechanical revert residue — verify blob identity before discarding (2026-08-15, PR #1424 run): When `sync-cli.ts` would abort `dirty_tree` because the working tree has dozens of modified+deleted files that don't match any branch's purpose, suspect a botched rebase/checkout that mechanically reverted already-squash-merged PRs to their pre-states. Diagnosis that proves it losslessly discardable: for each modified file, hash the working-tree blob and run `git log --all --find-object <blob>` — if every blob resolves to a historical pre-merge commit, and every deleted file still exists on HEAD/origin/main, the churn contains zero unique work; `git restore --worktree -- . ':(exclude).agents/memory/MEMORY.md'` (preserve the memory hot file) is safe. Also: delete untracked "resurrections" of files that were archived to `.planning/done/` only if byte-identical to the done/ copies (never keep both). On 2026-08-15 this pattern reverted merged PRs #1339–#1342 (77 files, +429/−8845) in the video_generation__memory worktree; resolved losslessly, PR #1424 (kp13 sdd docs) shipped. Also learned: sync-cli `--mode full` advances main + submodules but never rebases feature branches — after a merged squash PR, cut a fresh branch from origin/main and cherry-pick residuals instead of rebasing the old branch (an already-squash-merged commit's bookkeeping follow-up may cherry-pick EMPTY because the squash carried both commits — `git cherry-pick --skip` is correct there). Submodule note: sync's `submodule update --remote` re-dirties the gitlink if remote HEAD ≠ recorded pointer; fix with `git submodule update --checkout -- <path>` afterward.