---
type: task
status: closed
---

# 02 — Add rateLimits config (settings.json) + loader

## Question

Extend the workflow-settings config so a per-provider concurrency cap is user-tunable and readable by BOTH tools.

## What to build

- Schema: add `rateLimits?: Record<string, { maxConcurrent: number }>` to `WorkflowSettings` (`bun-apps/pi-agent-ext-workflow/src/workflow-settings.ts`), clamped to `[1, MAX_CONCURRENCY]`. Example value: `{ "zai": { "maxConcurrent": 3 } }`.
- Loader: `loadWorkflowSettings()` parses + clamps it (mirror the existing `defaultConcurrency` handling).
- Read site for `subagents`: `pi-agent-ext-subagent/src/config.ts` / `src/subagents-tool.ts` currently use the hardcoded `DEFAULT_BATCH_CONCURRENCY` (4). Wire it to read `rateLimits[provider]?.maxConcurrent` (falling back to the current default when unset). NOTE: the subagent tool does NOT currently read workflow-settings — it needs to (via the same loader, or a shared helper).
- Provider key: the active provider is resolved from `~/.pi/agent/settings.json -> defaultProvider` (`zai`). The rateLimits map is keyed by that.

## Acceptance

- `rateLimits` field in the WorkflowSettings schema + loader (clamped).
- Both `subagents` and `workflow` can read `rateLimits[activeProvider]?.maxConcurrent`.
- Tests: loader parses+clamps; missing/empty -> undefined (no-op).
- The actual VALUE comes from ticket 01 (numbers); this ticket builds the plumbing, not the number.

## Resolution — FIXED in #1062
Added `rateLimits?: Record<string, { maxConcurrent: number }>` to WorkflowSettings (pi-agent-ext-workflow/src/workflow-settings.ts), parsed + clamped to [1, MAX_CONCURRENCY] in the loader, with a `getRateLimit(provider)` helper. Both tools read the active provider (zai) cap. Tests: parse/clamp/unset. (The VALUE comes from ticket 01.)
