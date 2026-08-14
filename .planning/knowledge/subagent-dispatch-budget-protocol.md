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
