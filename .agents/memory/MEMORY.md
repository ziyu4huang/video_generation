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
§
---
id: 6f2dd59f-8396-4d80-9030-45842c201a1f
created: 2026-08-29
last: 2026-08-29
---
DevOps CLI quirks (video_generation repo, observed 2026-08-29): (1) Harness recipe tools deploy_pi_agent_sh / verify_pi_agent_deploy fail with "Could not locate the source s2-agent dir" when the session runs from a deployed dist inside a source worktree — they resolve the repo from the running dist's PI_AGENT_DIR, not cwd. Workaround (verified in video_generation__archify): use the CLI twins from repo root — `bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts`, and `PI_AGENT_DIR=$PWD/bun-apps/s2-agent bun bun-apps/s2-agent-ext-devops/scripts/run-test.ts --tier quick`; the twins resolve their own tree correctly. (2) prepare_feature_branch with branch:'auto' created a branch LITERALLY named "auto" instead of deriving the worktree-folder suffix — pass an explicit semantic branch name, and check for a spent same-name branch first (an old `archify` branch blocked `git branch -m` branch-exists; pick a distinct suffix like archify-sync). (3) Deploy-E2E model pin (since PR #2140): export `VERIFY_E2E_MODEL=deepseek/deepseek-v4-flash-vision-exp` before verify-deploy-e2e-cli / deploy-cli on this machine — default LM Studio bonsai-27b lane's ~36s cold start straddles the 35s budget (coin-flip verdict); pinned deepseek answers ~14–15.5s (2.4x headroom, deterministic). Format is `provider/model-id` (bare id = malformed → warning + unpinned); the pin also disables the local-endpoint contention precheck (it measures a lane the pinned one-shot never touches).
§
---
id: 9392e243-63e6-4bb1-85a3-fa2860ac8d21
created: 2026-08-29
last: 2026-08-29
---
Deploy-E2E now includes a `providers-catalog` probe (PR #2142, 2026-08-29): runs `--list-models` twice under a scratch agent-dir, patch ON vs OFF (dashed env derived from piConfig.name, e.g. S2_AGENT_PRE_LOAD_PROVIDERS); ON must list every baked PROVIDERS pair, OFF must drop them. Attribution marker for the pre-load-providers patch binding is `prism-ml/bonsai-27b` (baked-only; gemma-4-12b and qwen3.8-27b also exist in personal ~/.pi/agent/models.json, so they leak without the patch). Measured patch cost is noise: bakedProviderConfigs 1.39µs/call, --list-models wall unchanged (~0.61s).
§
---
id: 1028f9e2-eb2b-4969-93bf-10cb3fad2b45
created: 2026-08-30
last: 2026-08-30
---
GLM speed/effectiveness benchmark effort (started 2026-08-30, approved design): measured baseline on this machine (glm-5.3 @ thinking:high repo default, 8 recent sessions) — median turn latency 5.5–6.5s, p90 17–27s, output 66–78 tok/s, reasoning tokens 44–64% of output, steady-state cache hit 96–98% (cold 14–59%). Context tax per request: system prompt ~13.8k tok (59 skills ~6.3k), API tools schema ~25.2k tok. Hermes-memory prompt injection is policy-only mode (~750 tok MEMORY_POLICY block; failure injection capped at 5 entries / 7 days — not a major tax). Approved design: new permanent CLI subcommand bun-apps/s2-agent/src/cli/commands/bench-agent.ts built on runAgentSession/runSessionTurn (cli/sessions/shared.ts, resolveLLM supports provider/model:thinking per-run overrides) — focused matrix of fixture tasks × thinking-level configs (glm-5.3 high/medium/low + glm-5.3-highspeed) to tune pre-load-providers catalog + model tiers. Scope agreed with user: balanced latency+quality, catalog+tiers changes, focused matrix, permanent repo tool.
§
---
id: 79c012cb-293b-4e80-b2b9-3540fd4c59b0
created: 2026-08-30
last: 2026-08-30
---
bench-agent SDD conventions (2026-08-30, feat/glm-speed-benchmark): plan defects found by implementers are acceptable DONE_WITH_CONCERNS outcomes — controller must independently verify the reconstructed math before review dispatch. Bench task fixtures live under bench/tasks/** and LEAK under plain `bun test` (edit fixture fails 2 tests) — fixed via package script `bun test --path-ignore-patterns 'bench/tasks/**'` (script NAME unchanged so local_ci by-name gate resolution still works; anyone invoking bare `bun test` will still see the leaks). Task 4 full matrix = 20–40 min of real API runs; 3 env-gated e2e tests skip by default (1026 pass / 3 skip).
§
---
id: ea52ab7a-e072-4ced-94cd-ee3982469765
created: 2026-08-30
last: 2026-08-30
---
bench-agent per-turn timing pitfall (fixed in b5a1396f, 2026-08-30): pi-ai stamps AssistantMessage.timestamp at STREAM START (before fetch), so timestamp deltas between in-memory messages measure call-start gaps (~6ms), not generation time. On-disk JSONL timestamps differ (persist-time) — retrospective session analysis stays valid. Rule: any in-process timing of LLM turns must measure from message_end event arrival times, not message timestamps.
§
---
id: ff20a3a4-6c72-4659-9a89-9eba1869fae1
created: 2026-08-30
last: 2026-08-30
---
(2) glm-5.3-highspeed 'broken' cells (0 output tokens, empty replies, ~14.5s walls) were ROOT-CAUSED to 429 code 1311: the Z.AI subscription plan does not include GLM-5.3-Highspeed — entitlement, NOT a catalog bug. No pre-load-providers change needed; a data-cited comment was added on the highspeed entry (commit acb1e4c8). Harness gap noted: 429s didn't propagate into the cell's error detail. (3) Variance is real at n≤2: a 5.3-high analysis rerun FAILED quality (missing Cleo Frost) after passing run 1, while 5.3-flash passed both — single-run matrix cells are not definitive.
§
---
id: 4b42ec87-ad45-4452-b1dd-409c5425e4ad
created: 2026-08-30
last: 2026-08-30
---
bench-agent fixture double-protection (PR #2176, 2026-08-30): the package script's `bun test --path-ignore-patterns 'bench/tasks/**'` is NOT enough — local CI's test gate runs RAW `bun test`, which rediscovers bench/tasks/edit fixture tests that fail by design. Fix: skip-guard in the fixture test itself (active only when run from a temp copy / benchmark semantics; skip.testSkip when at repo location). Rule for future bench fixtures with by-design-failing tests: guard BOTH the package script and the fixture test body.