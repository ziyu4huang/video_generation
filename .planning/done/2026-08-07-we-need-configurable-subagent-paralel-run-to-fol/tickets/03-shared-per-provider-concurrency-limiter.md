---
type: task
status: closed
---

# 03 — Shared per-provider concurrency limiter + wire both tools

## Question

Build the single global, per-provider concurrency cap that BOTH `subagents` and `workflow` acquire, so combined parallel dispatch can't exceed the limit. Always-on when configured; no-op until set.

## What to build

- A process-global, per-provider counting semaphore (sibling shape to the existing in-flight registry singleton, `getSubagentInFlightRegistry()` — e.g. `getGlobalRateLimiter(provider)`). It reads its limit from the config (ticket 02's `rateLimits[provider].maxConcurrent`).
- Wire `subagents` (`runWithConcurrency`, `pi-agent-ext-subagent/src/subagents-tool.ts`) to acquire a slot from the global limiter per child (in addition to / capping its per-batch pool).
- Wire `workflow` (`createLimiter`, `pi-agent-ext-workflow/src/workflow.ts`) to acquire from the SAME global limiter (so the two paths share one budget), while preserving the per-run-tree limiter's existing behavior when no global cap is configured.
- Always-on-when-configured: if `rateLimits[provider]` is set, both tools clamp to it (the global limiter gates); if unset, behavior is unchanged (no-op — current per-batch / per-run limits stand).
- Live OUTSIDE the workflow vm (the vm neuters `Date.now()` for determinism) — the limiter is TS-orchestrator-layer, like `createLimiter`.

## Acceptance

- One shared per-provider limiter; both `subagents` and `workflow` acquire from it.
- Combined concurrent model calls <= `rateLimits[provider].maxConcurrent` when configured (testable via injected fakes).
- No-op when unconfigured (existing behavior + tests unchanged).
- Tests: green-path (cap respected across both paths), no-op-when-unconfigured, per-key-budget (two limiters for two providers don't interfere). Inject fakes (SpawnFn-style) for determinism.
- `bun run check` + `bun test` green for both packages.

## Notes

- The cap VALUE comes from ticket 01 (numbers) via ticket 02 (config). This ticket builds the machinery; it no-ops until 01+02 populate a value.
- Singular `subagent` is sequential (concurrency-1) — not wired (safe).

## Resolution — FIXED in #1062
Shared per-provider counting semaphore registered on `globalThis.__piRateLimitState` (Map<provider, limiter> + config resolver) — robust to workspace module-dedup, so pi-agent-ext-subagent and pi-agent-ext-workflow provably share ONE budget per provider. Wired as the OUTER bound on both `subagents` (runWithConcurrency) and `workflow` (agent()/createLimiter, outside the vm). Pass-through (no-op) when unconfigured — byte-identical pre-activation behavior. Cross-package sharing PROVEN by tests/rate-limiter-cross-pkg.test.ts (acquire-and-hold from one import path blocks the other).
