---
type: task
status: open
---

## Question

BUG: the subagent display may show an INCORRECT LLM model id. This env's primary/default models are GLM + deepseek, but the display showed `anthropic/claude-opus-4-1` — a model that shouldn't be in use.

**Example (from a video_generation__superpowers session):**
```
subagent ▸ converter-prototyper ▸ anthropic/claude-opus-4-1 ▸ "Repo: /Users/huangziyu/proj/video_generation__superpowers, …"
↳ Wrote .planning/2026-08-08-impr…instorm/sample-report.md
  ↳ 130.6s elapsed · 14 tool calls
```
Opus shouldn't be possible here (GLM default + deepseek). So the displayed model id is WRONG.

**Root-cause first (investigate + decide):**
1. Where does the model id in `renderSubagentCall` come from? (`subagent-tool.ts` renderCall ~867 → renderSubagentCall ~423: renders `<model|tier:…|capability:…|default> ▸ [resolvedModel]`.) Is the shown id the REQUESTED model param, the RESOLVED model, or a stale default?
2. Is the CALLER passing `anthropic/claude-opus-4-1` explicitly — and the run then FALLS BACK to GLM/deepseek (opus unavailable) — so the display shows the requested-but-unused opus, not the actual? OR is the model resolution/display itself buggy (stores/resolves opus incorrectly)?
3. What model did the run ACTUALLY use? Check the run record / usage / `resolvedModel`. If the display shows opus but the run used GLM, the display is showing the wrong field (requested vs actual).
4. Should the display show the ACTUAL/resolved model (what ran), especially when it differs from the requested (the fallback case)?

**Goal:** the display shows the model the run ACTUALLY used (GLM/deepseek), not a stale/wrong id (opus). If the caller requests an unavailable model + falls back, the display should reflect the fallback (the actual model).

Related: ticket 02 (live-display header — task-preview boilerplate). Both are live-display header accuracy issues. This ticket = the MODEL field correctness; ticket 02 = the TASK field richness. Could be investigated/fixed together.
