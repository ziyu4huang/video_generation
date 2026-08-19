---
id: 5e52bf2b-f03a-42f1-9df9-b0e348f11db0
created: 2026-08-17
last: 2026-08-17
---
docs/superpowers/ namespace RETIRED (user directive 2026-08-16): never write specs/plans/docs under docs/superpowers/ again — everything lives under .planning/ (.planning/specs/, .planning/plans/, audit dockets → .planning/audit/). Migration included: pi-agent-ext-task plan-coordinator legacy fallback switched from docs/superpowers/plans to .planning/plans (done BEFORE symlink removal), symlink deletion, guard test + ADR, and ~25 dangling reference fixes. Superpowers skills-fidelity guardrail: skills-fidelity.test.ts (ADR-0004) pins ported skills byte-equal to baseline fixtures — intentional drift from a merge/surgery MUST run bun scripts/rebaseline-upstream-skills.ts before tests pass.
§
---
id: 89f47e61-2353-4a48-b7ca-0298350e9c82
created: 2026-08-17
last: 2026-08-17
---
Effort .planning/2026-08-17-develop-pipeline/ (wayfind→superpowers↔subagents pipeline design): map+grill D5–D9 merged (#1575/#1578), spec.md merged (#1580), D1–D4/D7/D9 already satisfied by landed state — build surface is only skill-file modules M1–M5 (to-spec entry-criteria, writing-plans entry-criteria, verify-child rule in superpowers, budget ledger extension, CONTEXT-MAP as diagram-of-record home). Ticket format is the UNIFIED schema (YAML frontmatter type/blocking/status + ## Question/## What to build/## Acceptance) read by parseTicketFile; /wayfind done = manual move to .planning/done/ + status:complete + next-goal harvest — no automated mv, so efforts run without a map need a retro done-map.
§
---
id: da6eaf71-bf0b-4c95-a8d6-44f5895152f8
created: 2026-08-18
last: 2026-08-18
---
Wayfind conventions (2026-08-14–17): there is NO self-named skills/wayfind/SKILL.md — the wayfinder process lives in procedures/wayfinder.md, the grilling discipline in skills/grilling/SKILL.md, and ~22 SKILL.md files exist under bun-apps/pi-agent-ext-wayfind/skills/. Landed-work attribution: when a landed PR implements a standing decision in an effort map but has no existing ticket seat, record it as a NEW landed decision row in the owning effort's map.md (+ fog-item annotation), merging follow-up PRs into the same row. First verify the suspected effort actually owns the work. Keep tickets open when their declared interface is explicitly narrower than the landed work.
§
---
id: a39f1481-765c-4407-acd9-32d94ad4d1cd
created: 2026-08-18
last: 2026-08-18
---
Gitignored transient scratch files (standing rule, .gitignore): task_plan.md, progress.md, findings.md are per-filename carve-outs — do NOT commit them and never `git add -f` past the ignore. Children hitting this wall should leave them as local scratch; seeds/progress live local only.
§
---
id: 483dc9a6-fd15-4897-a466-2daa845e83cb
created: 2026-08-18
last: 2026-08-18
---
Subagent dispatch empirics (grounded 2026-08-18 from ~/.pi/subagents/runs/ — 200 parseable JSON run records): 166 done / 20 turn-capped / 14 budget-dead ≈ 17% death rate, zero unrecoverable failures — salvage/verify always recovers the work. Distilled to .planning/knowledge/subagent-dispatch-empirics.md. Recurring abort pattern: children die between 'staging' and 'commit' or mid-report — after every abort, verify git/PR state with fresh commands instead of redispatching full tasks; janitor finishers (verify → commit → push only) reliably close them. Also: unit-test decision logic with self-contained fakes instead of coupling to large existing test harnesses — three children died reading one 215-line harness before restructuring worked.
§
---
id: 22c8ac43-ceab-4521-8ceb-f15db22432e7
created: 2026-08-18
last: 2026-08-18
---
pi-agent.sh at repo root already exists as a symlink → bun-apps/pi-agent/run.sh, a pre-existing 238-line launcher (logic-free shim exec into bun src/cli.ts). Do not overwrite run.sh with a new shim — an early self-improve-loop child clobbered it and it had to be git-restored (ticket 01 closed as 'completed by pre-existing surface').
§
---
id: e83dcbaa-6053-4d29-a58c-6305737dafe4
created: 2026-08-18
last: 2026-08-18
---
DevOps + Git workflow lessons (2026-08-15–17): (1) Mass dirty-tree after sync = mechanical revert residue — verify blob identity before discarding (git log --all --find-object <blob>; if all blobs resolve to pre-merge commits, churn is zero unique work; git restore --worktree -- . is safe). Delete untracked "resurrections" only if byte-identical to done/ copies. (2) After squash-merge, cut fresh branch from origin/main instead of rebasing old branch (squash may carry both commits — git cherry-pick --skip for empty). (3) Worktree topology: main checked out at /Users/huangziyu/proj/video_generation; secondaries must use detached HEAD (checkout main fatal). All worktrees share ~/.pi/agent/settings.json → defaultModel/defaultProvider leak. After squash-merge, remote branch deleted; leftover local branch harmless. Sibling sessions move origin/main mid-session → re-fetch and list sibling PRs before branching/rebasing; check file overlap of open sibling PRs. (4) DevOps unification: port-then-delete rule — once logic ported into pi extension, delete standalone script. Import-depth pitfall when relocating directory trees — verify all relative imports after moving. deploy.ts cwd-guard lesson — tests must spawn with cwd=pi-agent while keeping DEPLOY path script-relative. (5) sweep-cli safety: default is dry-run (prints JSON plan). SAFE-to-delete requires POSITIVE gh evidence: MERGED PR for head ref AND no open PR reusing it. Triple guards (never deleted): branches checked out in any worktree, main/master/default, current branch.
§
---
id: d3215a26-f737-4812-a818-b09b5ebe98c5
created: 2026-08-18
last: 2026-08-18
---
Planning-effort hygiene sweep rule: after any sibling mass-archive/sweep, verify still-active efforts weren't swept (a mass-sweep once archived a still-active effort and needed a rescue PR). Plain-pi sessions lack extension tools (no wayfind_effort) — enumerate .planning/ via filesystem, listing bare dirs too (many efforts have no map.md), not only map.md-bearing ones.
§
---
id: 644730bd-7e55-4d1e-894a-d5a5b728659c
created: 2026-08-18
last: 2026-08-18
---
Knowledge-candidate → skill promotion pipeline (PR #1628, #1629, 2026-08-18): `.planning/knowledge/` candidates promoted via superpowers writing-skills test-first process. RED evidence = documented incident (verbatim session records count). EXPECTED_SKILLS count +1 in tests/skills.test.ts. UPSTREAM.ref LOCAL-DIVERGENCES row for repo-local additions. Candidate consumed on promotion. Status post-truth-sync: goal-loop-hygiene SUPERSEDED (no-progress tripwire #1625 fails need-gate); goal-loop-deadlock RESOLVED (fix #1625 landed). Superpowers count = 15 (14 upstream + repo-native dispatch-recovery). Home: bun-apps/pi-agent-ext-superpowers/skills/ (dispatching-parallel-agents owns pre-dispatch + verify-child; dispatch-recovery owns post-death recovery).
§
---
id: 4929d939-b2f7-4956-b89b-cd1f2e66252f
created: 2026-08-18
last: 2026-08-18
---
Self-improve loop surface (PR #1699, 2026-08-19): `./pi-agent.sh cli loop status` — report-only (always exit 0) 5-signal drift report over MVP packages (wayfind/superpowers/subagent + core-*; image/video extensions explicitly out of scope per user). Signals: dispatch death rate (broad <15% over ~100 runs, soak issue #1681), skill line budget (≤300/file), coverage floor, schema-cost, drift census. runStats parser must be line-start anchored so runs-stats cohort rows (`cohort x: n=154 done=119…`) don't false-match summary rows; also accepts keyword-first (`done 126`). New CLI commands follow `cli/commands/*.ts` + COMMANDS registry in dispatch.ts — forgetting the import causes silent fall-through to chat.
§

subagent tool vs direct-call gap: subagent tool seam 套用 role envelopes，但 direct `spawnSubagent()` 呼叫點無 cap。補救：`roleAwareDirectCall()` helper 統一 caps+abort-safety footer 原子同進退。（2026-08-18，#1654–#1661）
id: 1ebce484-10e9-408a-b8b1-769774a84268
created: 2026-08-18
last: 2026-08-18
runs DB persistence: `~/.pi/subagents/runs/*.json` 的 200/200 筆記錄全部帶完整 `usage` 欄位（input/output/cacheRead/total）。舊 empirics 說「run records don't persist tokenUsage」是過時主張，已推翻。（2026-08-18，#1667）
id: e78e356c-1640-4223-82c0-c026454c7c25
created: 2026-08-18
last: 2026-08-18
macOS + commit-scope anti-patterns (2026-08-18): GNU coreutils `timeout` 不存在，必須用 tool-level timeout 或 process 本身的 timeoutMs 參數；使用 shell `timeout` 會 exit 127 "command not found"。commit-scope 使用 `git add -A` 會 sweep 不相關檔案進 commit，造成 violation；必須使用明確路徑 `git add <files>`。 <!-- created=2026-08-18, last=2026-08-18 -->
id: 648fc159-d9de-4763-bd37-51d7da282354
created: 2026-08-18
last: 2026-08-18
parallel session 競態風險: 直接推 main 會被並行 session 的 pre-push CI 視窗截擋（~40s）。正確路徑: 分支推送→PR→pr-finish（API squash-merge）伺服器端原子處理。（2026-08-18，#1656 push 失敗案例）id: 6d248669-ce83-43a8-9fdd-4f174b891a30
Dispatch budget envelope closure chain complete (2026-08-18): #1652 tool-seam rebalance (recon 120k/12t, writer 400k/28t) → #1653 obsidian distill OB_SUBAGENT_TIMEOUT_MS 5→20min → #1654 zk_card/zk_ask role bounds via exported ROLE_AWARE_DISPATCH_BOUNDS → #1655 hermes background-review fallback recon caps → #1656 hermes session-flush/auto-consolidate (writer) + correction-detector (recon) caps. Pattern for capping a raw spawnSubagent site: spread roleAwareDefaults(role) into options but override with the site's existing tighter timeoutMs; SUBAGENT_TOKEN_BUDGET_DISABLE escape hatch; pin with per-site tests.
id: 2d40a851-883e-4140-ab73-b588f5b0c106
LeanRAG completion (2026-08-18, PRs #1619/#1623/#1639/#1648, effort archived 8f36e219): augmentEmbedText wired via `entityAugment` seam leaf in core-interface KnowledgePipeline — zk publishes entity-summary capability, hermes defensively reads; direct hermes→zk import is FORBIDDEN by dep-guard.test.ts (ADR-monorepo-0001 invariant #4, no allowlist). Embed staleness escapes via DEFAULT_EMBED_MODEL_VERSION bump (+es1 suffix triggers full delta re-embed). hierarchy hang-mode breaker = summaryBreaker K=3 knob in zk hierarchy.ts cluster loop. kgLlmModel precedence: call-opts > config.kgLlmModel (hermes loadConfig) > PI_KG_LLM_MODEL env.
