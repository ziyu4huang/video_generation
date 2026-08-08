---
type: task
status: closed
origin: 2026-08-08-subagents-follow-model-preset/tickets/01-fallback-to-tier-preset-before-session-default.md
---

## Question

Subagents should follow the `/models-preset` by default: when an explicit
`model` is unavailable in this environment, it must degrade to the preset (via
the caller's `tier`) — not silently to an arbitrary session default.

## Findings

- The orchestrator sometimes passes BOTH `model` (e.g.
  `anthropic/claude-opus-4-1`, unavailable here) AND `tier` (e.g. `medium`).
  The explicit `model` is the LLM's free choice — no agent def, no instruction
  constrains it; it ignores schema guidance.
- In `agent.ts`, `resolveAgentModelSpec` (Stage A) does
  `if (options.model) return options.model;` — an explicit model
  SHORT-CIRCUITS tier entirely. Tier resolution only runs when NO explicit model
  is given.
- The fallback branch (Stage B): `resolvedModel = await this.resolveModel(modelSpec)`.
  If the explicit model is unavailable, it previously fell straight back to the
  SESSION DEFAULT, discarding the caller's `tier`. So `opus(unavailable) +
  tier:medium` ignored `medium` entirely.
- Root-origin: this is an LLM free choice, not a config/instruction bug — so the
  fix belongs at the tool layer (`WorkflowAgent.run`), the one place the LLM
  can't bypass.

## Resolution

Shipped via #1106 (`fix(subagent): fall back to tier (preset) before session default`).

On an UNavailable explicit model, resolve the caller's `tier` (→ active
`/models-preset`) BEFORE the session default, and warn loudly:

- New pure helper `resolveFallbackModel(requestedSpec, {tier}, config, resolveModel)`
  in `agent.ts` decides `tier` vs `sessionDefault` and returns a loud one-line
  warning naming requested → tier → actual (or → session default). Pure +
  injectable so the decision is unit-testable without a real registry.
- `WorkflowAgent.run`'s fallback branch calls it: when a tier resolves to an
  available preset model, that becomes the run's model and `onModelResolved`
  fires with it; `onModelFallback(requested)` still fires in every fallback case
  (ticket-03's `fellBack` display flag). Only when there is no tier (or the
  tier's model is also unavailable) does it reach the session default — and
  ticket-03's post-session `onModelResolved(sessionActual)` still emits the
  actual model there.
- Stage A (`resolveAgentModelSpec`) is UNCHANGED — an explicit AVAILABLE model
  still wins. Only the unavailable path changes (tier-before-session-default).
- Net: `opus(unavailable) + tier:medium` → `medium` → preset → `glm-5.2`, with a
  visible warning and the display showing `opus → glm-5.2`. If the preset's
  medium differs from the session default, the preset now wins. "Subagents
  mostly follow the `/models-preset`."

+6 tests (`tests/agent-fallback.test.ts`); gate green (typecheck + 551 tests).
