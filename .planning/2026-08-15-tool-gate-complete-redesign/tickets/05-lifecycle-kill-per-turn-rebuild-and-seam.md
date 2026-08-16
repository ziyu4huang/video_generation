# 05 — Lifecycle: kill per-turn rebuild + subagent-child seam

type: task

## Question

Two lifecycle defects in `extensions/tool-gate.ts`:

1. **Per-turn rebuild waste (F6).** `before_agent_start` (`:486-505`) re-runs `getAllToolDefinitions()` + `buildEffectiveGates()` + `measureToolTokens()` for **every tool on every turn**, when the full def set only changes at `session_start`. The per-turn path only needs `updateSticky(prompt, …)` + `filterActive(…)` + `setActiveTools(…)`. A token-optimization extension doing redundant per-turn schema measurement is self-defeating.
2. **Subagent-child seam hack (F7).** In-process children (`WorkflowAgent.run` → `createAgentSession`) skip `session_start`, so `sticky` starts empty; the code re-seeds via a `sticky.size === 0` sentinel (`:499-502`). That sentinel is a magic value encoding a framework gap — a legitimate 0-core session would re-seed wrongly, and the shared closure state across parent+children is implicit.

Resolve: restructure so the full rebuild + `measuredTokens` build happen **once at session_start**, the per-turn path is pure gate-firing + filtering, and the child seam uses an **explicit per-session signal** (e.g. key `sticky`/`measuredTokens` by `ctx.sessionManager.getSessionId()` — the pattern power-tool's pathology accumulator already uses — instead of a size sentinel).

Note the interaction with ticket 01: if the contract becomes a gate registry, `session_start` subscribes once and the per-turn path reads the registry; the rebuild disappears by construction.

## Acceptance

`before_agent_start` performs no full-def/measure rebuild; child sessions seed from an explicit session id, not a `size===0` sentinel; `bun test` (incl. the subagent-spawn seam test) and `bun run qa` stay green.

blocked by: 01 (contract shape determines the rebuild path)
