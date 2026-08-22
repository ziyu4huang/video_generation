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
§
---
id: 94f61133-1fb2-4251-abfd-7c12990d3650
created: 2026-08-22
last: 2026-08-22
---
Wayfind + self-improve loop conventions (2026-08-14–19): wayfinder process lives in procedures/wayfinder.md (not skills/wayfind/SKILL.md); grilling discipline in skills/grilling/SKILL.md. Self-improve loop `./s2-agent.sh cli loop status` is report-only (exit 0), never mutates state. Landed-work attribution: when a PR implements a standing decision with no existing ticket seat, record as NEW landed decision row in owning effort's map.md (+ fog-item annotation), merging follow-up PRs into same row. Keep tickets open when declared interface is narrower than landed work.
§
---
id: 5849de95-8a14-44ce-8328-26b4c8b8b585
created: 2026-08-22
last: 2026-08-22
---
DevOps + Git workflow lessons (2026-08-15–22): (1) Mass dirty-tree after sync = mechanical revert residue — verify blob identity before discarding (git log --all --find-object <blob>; if all blobs resolve to pre-merge commits, churn is zero unique work; git restore --worktree -- . is safe). Delete untracked "resurrections" only if byte-identical to done/ copies. (2) After squash-merge, cut fresh branch from origin/main instead of rebasing old branch. (3) Worktree topology: main checked out at /Users/huangziyu/proj/video_generation; secondaries must use detached HEAD. All worktrees share ~/.pi/agent/settings.json. (4) DevOps unification: port-then-delete rule — once logic ported into pi extension, delete standalone script. Import-depth pitfall when relocating directory trees — verify all relative imports after moving. deploy.ts cwd-guard lesson — tests must spawn with cwd=s2-agent while keeping DEPLOY path script-relative. (5) sweep-cli safety: default is dry-run. SAFE-to-delete requires POSITIVE gh evidence: MERGED PR for head ref AND no open PR reusing it. Triple guards (never deleted): branches checked out in any worktree, main/master/default, current branch. (6) PR merges must go through devops toolchain (merge-pr-after-ci-cli.ts), not raw `gh pr merge --squash`. Same for rebase (prepare-feature-branch-cli.ts) and branch cleanup (sweep-merged-branches-cli.ts). Evidence: raw `gh pr merge --squash --delete-branch` failed branch cleanup with worktree-conflict error that sweep-merged-branches-cli handles correctly.
§
---
id: cd22cac9-f201-4c10-a5bf-3dae105b8524
created: 2026-08-22
last: 2026-08-22
---
video_generation: hermes-memory startup slowness (syncMarkdownMemories ~2-3.5s, 110 HTTP round-trips, backend=surrealdb, perf.jsonl 2026-08-22) pushes every REAL CLI boot to ~4.6s — which silently kills any bun test that spawns a real boot with the default 5s per-test timeout (status null). Fixed in #1816 with explicit trailing timeouts (30s, cast `as never` because pinned bun-types lack the overload): e2e-launcher symlink test + boot-smoke canary tests. If adding new real-boot tests, always set an explicit timeout ≥30s. The hermes sync cost itself is still an open perf item.
§
---
id: 39099165-aae0-407a-8050-dc648c6d4d89
created: 2026-08-22
last: 2026-08-22
---
video_generation / s2-agent CLI `--model provider/id` single-string routing — FIXED 2026-08-23 (default-model-env patch: any --model token suppresses the --provider bridge). Original 2026-08-22 diagnosis ("resolution happens before registerAllProviders, needs upstream core reordering") was WRONG. Real cause: the default-model-env argv-splice bridge injected `--provider zai` (from PI_PROVIDER env — the pi harness exports PI_PROVIDER/PI_MODEL to every child — or the built-in default) whenever the user passed only `--model lm-studio/qwen/qwen3.8-27b`; upstream resolveCliModel with an explicit cliProvider skips slash-inference, misses the id in the zai catalog, and buildFallbackModel fabricates a bogus zai model id → zai 400 "modelCode: does not exist". Proof: `env -u PI_PROVIDER -u PI_MODEL s2-agent --model lm-studio/qwen/qwen3.8-27b:off -p` worked on the UNFIXED deployed 0.1.1+g89ee4d8. Bare default "glm-5.3" still resolves to zai via unique exact match in models-store (only zai lists it — verified 2026-08-23). Both `--model provider/id` and `--provider X --model id` now work; explicit user --provider is never dropped.