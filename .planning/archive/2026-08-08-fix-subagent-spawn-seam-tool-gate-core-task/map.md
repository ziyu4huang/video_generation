# fix-subagent-spawn-seam — tool-gate × core-task × subagent cooperation

**Status:** Done — resolved with deferrals (stage-4 goalState deferred; see reconciliation umbrella)

**Supersedes / relates:** Shares-decision-with `2026-07-26-explorer-other-pi-agent-ext-` (fire-and-forget vs supervised runner ruling) and `2026-08-02-improve-extension-co-operation-` (owner-declared gating; no cross-extension deps). Relates-to core-task ticket #16 (state isolation) and the `2026-08-02-core-task-review` backlog.

## Problem

At the in-process subagent spawn seam, cooperation between **tool-gate** (active-set control), **core-task** (always-on state), and the **subagent extension** (spawner) breaks in three ways. All three share one root cause: **`session_start` never fires in a spawned child.**

1. **Child inherits the FULL ~55-tool universe, not the parent's gated ~24.** `pi-agent-ext-subagent/extensions/subagent.ts:126` captures `pi.getAllToolDefinitions()` (all tools) at `session_start`; `src/agent.ts:507-511` builds `customTools` from the full `extensionTools` set whenever the caller omits a `tools` allowlist. → Every spawned subagent re-pays the ~18,000 tok/req schema baseline the parent spent gating down to ~10,000. Under fan-out (`subagents`, workflow phases) this is the dominant waste.

2. **Child's tool-gate runs `before_agent_start` on an empty `sticky`.** `tool-gate.ts` seeds `sticky = new Set(effectiveCore)` ONLY in `session_start`; `before_agent_start` never re-seeds. The child skips `session_start`, so its gate runs with `sticky = {}` — core tools (`read/write/edit/bash`, `todo`, `goal_complete`, `ask_user_question`, `enable_tool`) sit in `effectiveTracked` but not `sticky` → asymmetric/under-inclusive gating, plus per-turn re-discovery/re-measurement the parent amortized once. Additionally, `pi.getAllToolDefinitions()` in the child returns only the child's OWN disk extensions (~10-15), NOT the ~50 bridged `customTools`, so the heavy bridged tools are untracked → fail-open → always active → full cost regardless.

3. **Child shares core-task mutable state with the parent.** todo (`pi-agent-ext-core-task/src/todo/state/store.ts:5-14` CAVEAT), goal (`src/goal/state.ts`), plan coordinator, and power-tool's pathology accumulator (`src/pathology/accumulator.ts`) are process-global module singletons reset ONLY on `session_start`. The child skips it → a subagent calling `todo` / `goal_complete` mutates the PARENT's todos / completes the PARENT's goal; its tool calls pollute the parent's pathology buffer. This is the documented open **ticket #16**.

## Root cause

`WorkflowAgent.run` (`pi-agent-ext-subagent/src/agent.ts:564-575`) calls `createAgentSession(...)` but does NOT call `bindExtensions()`. `session_start` is emitted ONLY inside `bindExtensions()` (SDK `agent-session.js:1741-1762`), which is called only by top-level runtime hosts (rpc/interactive modes), never by `WorkflowAgent.run`. The child DOES re-run extension factories (`resourceLoader.reload()` → `loader.js:408-409`) — so handlers register — and `before_agent_start` fires per turn, but `session_start`-keyed seeding/reset is inert or stale in the child.

## The co-work model

```
MAIN SESSION (full host boot)
  bindExtensions() → emits session_start ─────────── the ONLY session_start
    ├─ tool-gate:  sticky = effectiveCore; measureTokens once; setActiveTools(~24/55); banner
    ├─ core-task:  replaceState(EMPTY_STATE); refresh plan; mount widget
    └─ subagent:   capture getAllToolDefinitions() → FULL ~55-tool set + mainModel
  per turn → before_agent_start
    ├─ tool-gate:  re-discover, updateSticky, setActiveTools
    └─ subagent:   force-activate its 3 tools

parent calls `subagent` (no `tools` allowlist)
  spawnSubagent → WorkflowAgent({extensionTools: <FULL ~55>})
    createAgentSession({ customTools = applyToolPolicy([base, <FULL>], ∅, ∅) = ~55,
                         SessionManager.inMemory()  /* isolated history */
                         /* NO bindExtensions → NO session_start */ })
      ├─ factories re-run (handlers registered, fresh closures)
      ├─ session_start  ✗ NEVER EMITTED
      └─ before_agent_start ✓ fires each turn — on UNSEEDED state
```

The child has isolated conversation + model, but its tool universe is the parent's FULL set and its task/gate state is process-shared.

## Optimizations (ranked)

| # | Opportunity | Impact | Safety | Status |
|---|---|---|---|---|
| **1** | **Thread the parent's gated active set into the child** — when the `subagent`/`subagents` caller omits `tools`, default the child's tool set to `pi.getActiveTools()` instead of the full definition universe. Caller's explicit `tools` still overrides. | **Highest** (kills the ~8k tok/child re-pay) | Safe, independent | CLOSED (shipped #1127, aee00a44) |
| **2** | **Seed the child's tool-gate** — idempotent `ensureSeeded()` in `before_agent_start` that seeds `sticky` from `effectiveCore` (and builds `measuredTokens` once) when `sticky` is empty. | Med (correctness + per-turn cost) | Safe, independent | CLOSED (#1129, live) |
| **3** | **Isolate core-task/accumulator state by sessionId** — key the module singletons (`Map<sessionId, State>`) so children don't share the parent's todos/goal/pathology. | Med-High (correctness) | Med (touches 4 singletons) | stages 1-3 DONE (#1132/#1133/#1135); stage-4 (goalState) DEFERRED |
| 4 | Skip re-loading disk extensions in the child when `customTools` already bridges them. | Low-Med (startup CPU) | Med | DEFERRED |
| 5 | Slim core-task's always-on footprint — audit whether `ask_user_question` (large modal schema) must be `core:true` vs lightly gated. | Med | Low | ATTEMPTED + REVERTED (#1142 → reverted via #1145; miss-rate A/B 81% adversarial miss) |
| 6 | Dedupe per-turn gate rebuild in children. | Low | — | Subsumed by #2 |

## KEY CONSTRAINT (do not violate)

Do NOT fix #2 by firing `bindExtensions()` / `session_start` in the child. That would make #3 WORSE: the child's `session_start` would call core-task's `replaceState(EMPTY_STATE)` on the SHARED module singleton, wiping the parent's todos/goal. Use the surgical `ensureSeeded()` in tool-gate's own closure instead (touches only tool-gate state). **#3 (sessionId-keyed state isolation) is the prerequisite** for ever safely firing `session_start` in children — until #3 lands, only per-extension surgical fixes are safe.

## Tickets
- `tickets/01-thread-active-set-into-subagent.md` (#1) — CLOSED (shipped #1127)
- `tickets/02-tool-gate-ensure-seeded.md` (#2) — CLOSED (#1129, live)
- `tickets/03-state-isolation-sessionid.md` (#3, = core-task ticket #16) — stages 1-3 DONE (#1132/#1133/#1135); stage-4 (goalState) DEFERRED
- `tickets/05-slim-core-task-always-on-footprint.md` (#5) — REVERTED (#1142 gated ask_user_question + todo out of core; miss-rate A/B 81% miss → reverted via #1145, both back to core:true)
