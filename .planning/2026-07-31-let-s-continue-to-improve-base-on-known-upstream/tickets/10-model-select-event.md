---
type: grilling
blocked by: []
status: open
---

# 10 — Decide: `model_select` event subscription

**Source**: 01#4 · axis `upstream-sync` · **Impact 3 / Effort 1 / score 15** (rank 6)

**Gap**: main model is captured once at `session_start` (`workflow.ts:156`
`manager.setMainModel(ctx.model…)`, `subagent.ts:97` `mainModelHolder.current =
ctx.model…`). The `model_select` event ("fires when user switches via `/model` or
Ctrl+P") is **not subscribed**. A mid-session model switch leaves the workflow's
tier-fallback and the subagent's `mainModel` fallback bound to the session-start
model.

**Improvement shape**: add
`pi.on("model_select", (e, ctx) => { manager.setMainModel(...); mainModelHolder.current = ...; })`
so tier-fallback tracks the live model.

## Question

**do / defer / skip?** Trivial effort (one handler, two call sites). Recommend
`do` — cheap correctness fix; only debate is whether to also re-resolve an
already-spawned in-flight agent's fallback (recommend: no, apply to future
dispatches only).
