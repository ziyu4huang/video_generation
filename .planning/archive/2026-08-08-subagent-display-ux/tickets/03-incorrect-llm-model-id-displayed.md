---
type: task
status: closed
origin: 2026-08-08-subagent-display-glanceable-by-default/tickets/03-incorrect-llm-model-id-displayed.md
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

## Findings

**Root cause**: the model-resolution fallback path drops the signal — both the live display and the durable record echo the REQUESTED model (`anthropic/claude-opus-4-1`) while the run ACTUALLY used the session default (`zai/glm-5.2`).

- `renderSubagentCall` (subagent-tool.ts ~451): the model slot = raw REQUESTED `params.model`; the actual model appears ONLY via a 2nd `resolvedModel` segment (~457) which fires only on resolution SUCCESS.
- The fallback branch (`src/agent.ts` ~469-476): when `resolveModel(spec)` fails (model not in registry), it warns + falls back to the session default + fires `options.onModelFallback(modelSpec)` — but the tool ONLY wires `onModelResolved` (subagent-tool.ts ~730), NEVER `onModelFallback`. So on failure, neither the live display nor the durable record learns the actual model; both echo the requested string.
- Confirmed: `anthropic/claude-opus-4-1` is not in this env (no anthropic provider, `auth.json` = `{}`); the 2 opus-tagged runs actually ran `zai/glm-5.2` ($0 cost signal); the caller explicitly passed `model: anthropic/claude-opus-4-1`.
- Persistence (subagent-tool.ts ~766, ~837): `model = resolvedModel ?? displayModelBeforeResolve` → with resolvedModel undefined, the REQUESTED string is persisted. The record has no actual/fallback field.

## Resolution

**Approach**: "show requested → actual + `requestedModel` audit field" (do NOT redesign). On model-resolution FALLBACK, the display shows BOTH requested + actual (e.g. `anthropic/claude-opus-4-1 ▸ → zai/glm-5.2`), and the durable record stores the ACTUAL model as `model` PLUS a new optional `requestedModel` field (the audit trace).

Changes:
1. **agent.ts fallback branch**: after `createAgentSession`, read the session's actual model (`session.model`) and emit `onModelResolved(actual)` IN ADDITION to the existing `onModelFallback(modelSpec)`. The downstream tool now learns what actually ran even on fallback.
2. **subagent-in-flight.ts**: added `requestedModel?: string` and `fellBack?: boolean` to `InFlightSubagent`; added `markFallback(id, requestedModel)` method to set both without touching `resolvedModel`.
3. **subagent-tool.ts**:
   - Wired `onModelFallback` → calls `registry.markFallback()` to set `requestedModel` + `fellBack` on the in-flight entry.
   - `renderSubagentCall`: when `fellBack`, renders `→ actualModel` after the requested slot (fallback indicator). Normal resolution (▸) unchanged.
   - `SubagentToolDetails` / `SubagentRunRecord`: added OPTIONAL `requestedModel?: string` and `fellBack?: boolean`. Old records stay valid (no migration).
   - Persistence: stores `requestedModel` + `fellBack` when the model fell back.
4. **Tests**: +7 tests (renderSubagentCall with fellBack, in-flight markFallback, execute with fallback → details.requestedModel/fellBack, normal resolution → no audit fields, persistence carries audit fields). Gate: 532 → 539 pass.
