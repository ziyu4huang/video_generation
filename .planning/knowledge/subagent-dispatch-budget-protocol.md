# Subagent dispatch budget protocol (candidate skill)

## Trigger / symptom
Write/research subagent children in this repo die with "tokens budget exhausted" at 80k–540k despite small-looking tasks; tokenBudget caps abort but do not prevent the burn.

## Lesson
- tokenBudget is checked per-turn and may overshoot one turn: it is an abort line, not a spend governor.
- Each child turn re-pays a large fixed overhead (system prompt + AGENTS.md + CLAUDE.md + tool schemas, ~10k+ tokens). Turn count — not task size — dominates cost for bounded tasks.
- Evidence 2026-08-14: 3-command state check = 13.5k tokens (1–2 turns); same-size locator split into 6 command groups = 60–69k (many turns); research/write children with open-ended prompts = 400k+ deaths.

## Procedure
1. Collapse bash work into ONE verbatim command block per dispatch ("run exactly this, paste capped output, stop") — 1–2 turns total.
2. tier: "small" + tools: ["bash"] for locator/state tasks; embed pre-researched facts in the prompt instead of letting the child explore.
3. For write children: give verbatim edits / verbatim plan steps; forbid repo-wide grep (use --exclude-dir=node_modules,.git,venv,mlx-models,dist,vaults_root + `| head`).
4. Children must paste RAW command output, not summaries (lazy-summary drift observed on glm small tier) — state "your entire reply must be the raw stdout".
5. Keep tokenBudget as the abort line; right-size timeoutMs; check state via a 1-turn child after any suspected death instead of re-running the full task.

## Evidence
Subagent runs 2026-08-14 (mst0uvo9 13.5k 1-turn vs mst0wg3j 60k multi-turn vs 212k/418k/538k budget-aborts).

## Policy update (2026-08-15)

Decision after 6 budget-exhaustion deaths in a single session (dispatches passed explicit tokenBudget 300k–900k, all below tier defaults): **controllers must NOT pass an explicit tokenBudget below the tier defaults** (small 500k / medium 1.2M / big 1.5M in `bun-apps/pi-agent-ext-subagent/src/budget-defaults.ts`). Tier defaults are p90-calibrated abort lines — let them apply. Explicit tokenBudget is reserved for deliberate spend caps requested by the user. When children burn budget, fix the dispatch shape (this protocol), not the number. Corollary observed live: even a 1-call memory-write dispatch died at 50k when handed a 50k budget — never hand out budgets that small.

## Addendum 2026-08-15 (budget-hardening SDD session)

- Children reliably die AT THE REPORT EDGE when ceiling ≈ tier default (deaths at 1.21M/1.23M/1.50M/0.93M across explicit ceilings). Two mitigations proven: (a) order the dispatch "COMMIT + PUSH + PR BEFORE composing your report" — saved T3a intact; (b) when a child dies with a dirty tree, SALVAGE the uncommitted work in a small verify+commit dispatch instead of re-dispatching from scratch — three salvages, three successes (T2, T3b, maxTurns tests).
- Scope-splitting beats ceiling-raising: the 6-file cross-schema T3b dispatch died 3x; splitting maxTurns into core-runtime half (T3a, 1 commit, clean) + threading half (salvaged) worked. One package per dispatch stays the rule.
- NEVER allow a child `git reset --hard` / `git checkout -- .` in a shared worktree: one finisher wiped another session's uncommitted `.agents/memory/MEMORY.md` edits (unrecoverable). Guardrail text must name these commands explicitly.
- Finisher/salvager children may self-merge via `gh ship` even when told "do NOT merge" (observed 2x). Compensate: always run a post-hoc bounded review of the squash commit — it caught real gaps once (missing tests, #1336) and confirmed clean once (#1332).
- Watchdog commit-scope lists flagged false positives on ~every dispatch, but also caught the ONE real `git add -A` sweep (MEMORY.md + submodule in a planning commit). Rule: verify `git show --stat <squash>` payload against the task's file list before/after every merge.
- maxTurns (opt-in turn governor, TURNS_EXHAUSTED, retried-once) and the 80% warning + mid-turn onUsage abort are now SHIPPED (#1329/#1332/#1335/#1336/#1337) — this protocol's "turn count dominates cost" lesson now has a first-class enforcement lever; prefer `maxTurns` over shrinking tokenBudget below tier defaults.
