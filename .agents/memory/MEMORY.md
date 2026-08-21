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
Wayfind conventions (2026-08-14–17): there is NO self-named skills/wayfind/SKILL.md — the wayfinder process lives in procedures/wayfinder.md, the grilling discipline in skills/grilling/SKILL.md, and ~22 SKILL.md files exist under bun-apps/s2-agent-ext-wayfind/skills/. Landed-work attribution: when a landed PR implements a standing decision in an effort map but has no existing ticket seat, record it as a NEW landed decision row in the owning effort's map.md (+ fog-item annotation), merging follow-up PRs into the same row. First verify the suspected effort actually owns the work. Keep tickets open when their declared interface is explicitly narrower than the landed work.
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
s2-agent.sh at repo root already exists as a symlink → bun-apps/s2-agent/run.sh, a pre-existing 238-line launcher (logic-free shim exec into bun src/cli.ts). Do not overwrite run.sh with a new shim — an early self-improve-loop child clobbered it and it had to be git-restored (ticket 01 closed as 'completed by pre-existing surface').
§
---
id: e83dcbaa-6053-4d29-a58c-6305737dafe4
created: 2026-08-18
last: 2026-08-18
---
DevOps + Git workflow lessons (2026-08-15–17): (1) Mass dirty-tree after sync = mechanical revert residue — verify blob identity before discarding (git log --all --find-object <blob>; if all blobs resolve to pre-merge commits, churn is zero unique work; git restore --worktree -- . is safe). Delete untracked "resurrections" only if byte-identical to done/ copies. (2) After squash-merge, cut fresh branch from origin/main instead of rebasing old branch (squash may carry both commits — git cherry-pick --skip for empty). (3) Worktree topology: main checked out at /Users/huangziyu/proj/video_generation; secondaries must use detached HEAD (checkout main fatal). All worktrees share ~/.pi/agent/settings.json → defaultModel/defaultProvider leak. After squash-merge, remote branch deleted; leftover local branch harmless. Sibling sessions move origin/main mid-session → re-fetch and list sibling PRs before branching/rebasing; check file overlap of open sibling PRs. (4) DevOps unification: port-then-delete rule — once logic ported into pi extension, delete standalone script. Import-depth pitfall when relocating directory trees — verify all relative imports after moving. deploy.ts cwd-guard lesson — tests must spawn with cwd=s2-agent while keeping DEPLOY path script-relative. (5) sweep-cli safety: default is dry-run (prints JSON plan). SAFE-to-delete requires POSITIVE gh evidence: MERGED PR for head ref AND no open PR reusing it. Triple guards (never deleted): branches checked out in any worktree, main/master/default, current branch.
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
Knowledge-candidate → skill promotion pipeline (PR #1628, #1629, 2026-08-18): `.planning/knowledge/` candidates promoted via superpowers writing-skills test-first process. RED evidence = documented incident (verbatim session records count). EXPECTED_SKILLS count +1 in tests/skills.test.ts. UPSTREAM.ref LOCAL-DIVERGENCES row for repo-local additions. Candidate consumed on promotion. Status post-truth-sync: goal-loop-hygiene SUPERSEDED (no-progress tripwire #1625 fails need-gate); goal-loop-deadlock RESOLVED (fix #1625 landed). Superpowers count = 15 (14 upstream + repo-native dispatch-recovery). Home: bun-apps/s2-agent-ext-superpowers/skills/ (dispatching-parallel-agents owns pre-dispatch + verify-child; dispatch-recovery owns post-death recovery).
§
---
id: 4929d939-b2f7-4956-b89b-cd1f2e66252f
created: 2026-08-18
last: 2026-08-18
---
Self-improve loop surface (PR #1699, 2026-08-19): `./s2-agent.sh cli loop status` — report-only (always exit 0) 5-signal drift report over MVP packages (wayfind/superpowers/subagent + core-*; image/video extensions explicitly out of scope per user). Signals: dispatch death rate (broad <15% over ~100 runs, soak issue #1681), skill line budget (≤300/file), coverage floor, schema-cost, drift census. runStats parser must be line-start anchored so runs-stats cohort rows (`cohort x: n=154 done=119…`) don't false-match summary rows; also accepts keyword-first (`done 126`). New CLI commands follow `cli/commands/*.ts` + COMMANDS registry in dispatch.ts — forgetting the import causes silent fall-through to chat.
§
---
id: 56eb5722-6988-43c9-b022-87be48e12c7f
created: 2026-08-21
last: 2026-08-21
---
Main health (2026-08-21) shows 5 packages with failing test gates: s2-agent-ext-movie-director (selectProvider soft-hint probe), s2-agent-ext-subagent (biome unused imports), s2-agent-ext-superpowers (biome unsafe literal-key fix), s2-agent-ext-task (IO-round-trip tests via PI_CODING_AGENT_DIR fail — real ~/.pi/agent/settings.json polluted), s2-agent-ext-wayfind (same IO-round-trip issue). Running fix-main-green-5pkgs branch to resolve.
§
---
id: f0afbc32-edfa-44c4-a457-dcc850779047
created: 2026-08-21
last: 2026-08-21
---
Subagent tool gaps & platform fixes (2026-08-18, #1654–#1667): subagent tool envelopes roles but direct spawnSubagent() lacks caps → roleAwareDirectCall() helper unifies. runs DB persists full usage (input/output/cacheRead/total) — earlier empirics were wrong. macOS: GNU timeout unavailable (use tool-level/timeoutMs), commit-scope must use explicit paths not `git add -A`. Parallel push to main races with sibling CI (~40s) → branch→PR→pr-finish atomic squash-merge. Dispatch budget envelope chain: #1652 tool-seam rebalance (recon 120k/12t, writer 400k/28t) → #1653 OB_SUBAGENT_TIMEOUT_MS 5→20min → #1654 ROLE_AWARE_DISPATCH_BOUNDS → #1655 hermes recon caps → #1656 hermes writer caps. LeanRAG completion (#1619/#1623/#1639/#1648): embedText via entityAugment seam in KnowledgePipeline; no direct hermes→zk import (ADR-monorepo-0001 #4); embed staleness via DEFAULT_EMBED_MODEL_VERSION bump; hierarchy hang via summaryBreaker K=3; kgLlmModel precedence: call-opts > config.kgLlmModel > PI_KG_LLM_MODEL.
§
---
id: 8675fe33-4887-46d9-9165-f5878fcbe448
created: 2026-08-21
last: 2026-08-21
---
The pi/s2-agent harness leaks PI_PACKAGE_DIR (+BUN_PI_EMBEDDED_EXTRACT_DIR) into every child process including `bun test` runs. pi-coding-agent's config.js resolves package.json via getPackageDir() (honoring PI_PACKAGE_DIR) at module init — under the leak, APP_NAME becomes "s2-agent" (embedded-assets piConfig.name), so getAgentDir() honors S2-AGENT_CODING_AGENT_DIR instead of PI_CODING_AGENT_DIR, themes resolve to embedded-assets (missing in dev trees), and extensions' skill/asset dirs resolve to the deployed extraction. Symptoms: wayfind/task settings IO tests, subagent theme ENOENT, superpowers skillPaths=[], all failing under check_main_health (2026-08-21, fixed in #1784). Canonical fix: reuse s2-agent's bunfig preload `bun-apps/s2-agent/scripts/scrub-session-env.preload.ts` (narrow rule — deletes PI_PACKAGE_DIR only when it points at .pi/agent/embedded-assets; #1775) in ANY extension package whose tests import pi-coding-agent; bun test does NOT read a parent bunfig, so the preload must be wired per-package via a package-local bunfig.toml (listed at top-level AND [test]). Alternative for extension-specific resolution: pass import.meta.url through the injectable fromUrl seam (superpowers' resolveSkillsDir/getBootstrapContent pattern).