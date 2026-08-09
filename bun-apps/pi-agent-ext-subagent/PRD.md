# Subagent Extension PRD

## Agent dispatch abort findings (2026-08-09) — "agent vibe coding" learnings

### What happened
Implementing ticket 01 (model-aware default `tokenBudget`) of the `2026-08-09-subagent-efficiency-guardrails` effort, FIVE consecutive subagent dispatches aborted on token-budget exhaustion — ~1.2M tokens burned, zero output shipped:

| # | Model | Task | Tokens / cap |
|---|---|---|---|
| 1 | zai/glm-5.2 | SDD implementer | 533,753 / 500,000 |
| 2 | zai/glm-5.2 | read-only recon (3 files) | 104,927 / 100,000 |
| 3 | zai/glm-4.7 | SDD implementer (retry) | 419,236 / 400,000 |
| 4 | zai/glm-4.7 | diagnose + read 3 regions | 67,967 / 60,000 |
| 5 | zai/glm-4.7 | mechanical write (content provided) | 114,524 / 100,000 |

(Run id #1: `mslqif9b`; #2–#5 2026-08-09 ~11:40–12:00 UTC — see `~/.pi/subagents/runs`.)

### Root cause
1. **Models are token-inefficient on multi-step tasks.** #4 — a "git status + read three small regions" task — hit 68k on glm-4.7 (should be ~15k). The GLM models don't reliably follow read-optimization ("grep -n first, read small regions"); they read whole large files + emit verbose reasoning. glm-5.2 burns ~3–5× glm-4.7. **Counter-finding: minimal, decision-free prompts succeed; verbose/detailed prompts abort.**
2. **Dispatch anti-pattern.** The orchestrator re-dispatched the same failing task 5× — each retry re-paid investigation, none accumulated progress. Retrying a failing approach is itself the waste.
3. **`git add -A` disregard.** #3 and #5 staged unrelated files via `git add -A` despite explicit prohibition, sweeping accumulated stashed/prior-session cruft. Models ignore prose prohibitions.

### Implications for agent-driven development ("agent vibe coding")
- **Budget guardrails are necessary but NOT sufficient.** A default `tokenBudget` (ticket 01) catches the runaway tail (927k–3.4M) but can't make an inefficient model efficient. The aborts PROVE the budget works (it stopped the waste); the unsolved problem is upstream — model selection, prompt shape, task decomposition.
- **Model selection is the highest-leverage lever.** glm-4.7 ≪ glm-5.2 in token cost. Route cheap models to focused, well-specified tasks; reserve big models for genuine synthesis.
- **Minimal prompts win.** Decision-free, linear, short prompts complete; long detailed prompts (GUARD/REPORT/multi-option) trigger verbose reasoning → aborts. Give the model a script to execute, not a spec to interpret.
- **Multi-step balloons; single-step doesn't.** 10–12k single-command verifiers succeed; every abort was multi-step. Decompose aggressively; do trivial ops in the orchestrator.
- **Pre-resolve before dispatch.** Hand the implementer a precise, mechanical change — not "investigate then implement." Open-ended investigation on these models → loops → aborts.
- **`commitScope` must be default + enforced** (ticket 02) — opt-in detection only catches sweeps when passed; the models ignore "no git add -A" prose.

### Links
Effort `.planning/2026-08-09-subagent-efficiency-guardrails/` (map + spec + tickets 01–05). Ticket 05 (dispatch-discipline skill) shipped #1158. Tickets 01–04 open; 01 rework = pre-resolve injection point in orchestrator + precise patch + glm-4.7 + single bounded dispatch.
