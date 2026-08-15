---
type: task
status: closed
blocked by:
findings: H4
resolved: 2026-08-12 — shipped in #1058 — `extractModelRuntime` defensive guard + contract test
---

# 07 — Auditor `modelRuntime` access: defensive guard + CI contract test

## Problem

The auditor reuses the parent `ModelRuntime` via a `private readonly`-field cast. It works today (the field is a plain enumerable property at runtime) but breaks **silently** on a pi upgrade (rename → `undefined`, accepted because `createAgentSession.modelRuntime` is optional → vague "no model/auth" failure). The test fakes `{ runtime: {} }`, so a rename passes `bun test` clean and only fails on a live audit.

## Evidence

- `core-task/src/goal/auditor.ts:122` — `(ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime`.
- Field is `private readonly` in pi 0.82.0 (`pi-coding-agent/dist/core/model-registry.d.ts:20`) but plain enumerable at runtime (`.js:9`).
- `createAgentSession` `modelRuntime?` is optional (`sdk.d.ts:16`).
- Test fakes it: `auditor.test.ts:143` (`modelRegistry: { runtime: {} }`).

## Approach

1. **Defensive guard** in `runGoalCompletionAuditor`: read once into `const rt = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;` and `if (!rt) return { approved:false, disapproved:false, output:"", model:modelLabel(model), error:"ModelRegistry.runtime unavailable on this pi version — auditor disabled" }`. An upgrade now breaks **loudly** with an actionable message.
2. **CI contract test:** construct (or mock) a real `ModelRegistry` and assert the field is readable by the name `runtime` — so a rename is caught at CI, not at audit time.
3. **(Optional, upstream):** request pi expose a public `getModelRuntime()` (or make the field `readonly public`) — it's already semantically public via `createAgentSession` consumers.

## Acceptance

- [ ] Defensive guard in place; an audit with a missing runtime returns the clear error (test).
- [ ] Contract test asserts the field name against a real/realistic `ModelRegistry`.
