---
type: grilling
blocked by: []
status: closed
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

## Done (2026-08-16)

**Decision: DO — implemented.**

- Handlers: `pi.on("model_select", …)` at
  `pi-agent-ext-workflow/extensions/workflow.ts:223` (`manager.setMainModel`)
  and `pi-agent-ext-subagent/extensions/subagent.ts:154`
  (`mainModelHolder.current`) — both mirror their `session_start` captures.
- Semantics: **future-dispatches-only**; in-flight runs are not mutated
  (per the recommendation above).
- `event.model` may be `undefined` (model cleared) → holders accept `undefined`.
- Test: `pi-agent-ext-workflow/tests/extension-model-select.test.ts`
  (spies `WorkflowManager.prototype.setMainModel`; asserts switch
  `prov-a/id-a` → `prov-b/id-b` and clear-on-`undefined`). Subagent side
  untested — `mainModelHolder` is closure-private with no light harness; its
  handler is a 9-line mirror of the tested workflow path.
- Gates: workflow 1079 ran / 0 fail (was 1078 + 1 new test); subagent 626 / 0.
