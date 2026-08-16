---
type: grilling
blocked by: []
status: closed
---

# 11 — Decide: honor `ctx.scopedModels` in model-tier picker

**Source**: 01#3 · axis `upstream-sync` · **Impact 4 / Effort 3 / score 12** (rank 7)

**Gap**: `ctx.scopedModels` (0.83.0, changelog #7191/#7215) — "use it to populate a
picker instead of enumerating the whole catalog." `/workflows-models`
(`workflows-models-command.ts:36–44`) and `WorkflowAgent.getRegistry()`
(`agent.ts:249–260`) both use `registry.getAvailable()` (full catalog). A parent
dialog with `--models anthropic/*:high` / `enabledModels` still offers/routes
subagents to **out-of-scope models**.

**Improvement shape**: accept `ctx.scopedModels` in `/workflows-models` and
propagate the scoped set (or a warning) into `WorkflowAgent.resolveModel` so
children obey the conversation scope.

## Question

**do / defer / skip?** If **do**: lock behavior when scopedModels is empty
(recommend: fall back to full catalog, current behavior) and whether an
out-of-scope request is hard-error or warn-and-clamp (recommend warn-and-clamp).

## Done (2026-08-16)

- decision: do, with locked behaviors: empty scopedModels → full catalog/no clamp (current behavior); out-of-scope request → warn-and-clamp to first scoped spec (log() warning), never hard-error.
- Premise re-verified on pi 0.84.2: ctx.scopedModels IS typed (dist/core/sdk.d.ts:22, Array<{model, thinkingLevel?}>); ticket's cited sites were stale — real sites: src/workflows-models-command.ts (picker, was listAvailableModelSpecs full catalog) + src/workflow-runtime.ts (dispatch).
- Impl: clampModelToScope pure helper (model-routing.ts, unit-tested ×4); picker scopes to ctx.scopedModels with stale tier value kept visible; session_start capture (extensions/workflow.ts) → WorkflowRunOptions.scopedModels → WorkflowManager propagation → runtime clamp at dispatch (future dispatches only).
- Gates: biome clean; 1083 tests / 0 fail (was 1079).
