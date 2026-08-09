# 02 — Cross-ext store access

## Question

How does the superpowers coordination layer mutate goal-todo's state to sync plan progress — and does the chosen path hit the jiti module-identity split?

Two candidate paths:

- **(a) Programmatic** — `import { commitState, replaceState, getTodos } from "@repo/pi-agent-ext-goal-todo/..."`. Silent, no agent round-trip. **RISK:** jiti may load a second module instance → writes land in a different store than the `todo` tool reads (the exact gotcha `status-widget.ts` solved with a `globalThis` singleton).
- **(b) Tool round-trip** — invoke the `todo` tool programmatically (or emit a synthetic tool call). Agent-visible, no module-identity risk, but heavier and may double-log.

Investigate and recommend: which path is safe given pi's loader; whether goal-todo already exposes a `globalThis` seam for **state mutation** (today only a READ seam `__piGoalActive` exists); and if (a), whether a new process-singleton seam (mirroring `__piPowerToolStatusWidget`) is required.

### Context (pre-gathered)

- goal-todo store exports: `getTodos / getNextId / getState / replaceState / commitState / __resetState` (`src/todo/state/store.ts`).
- Existing `globalThis` seams are READ-only: `__piGoalActive` (goal-todo→plan-coordinator), `__piWayfindActive`. The shared widget uses `__piPowerToolStatusWidget` (process-singleton) **precisely because** of the jiti dual-instance risk — see its doc comment.
- `pi-goal-todo.ts` is positioned early in `run-dir/manifest.json` load order.

type: research
claimed: pi-agent
blocked by: —
status: closed

## Resolution (closed 2026-07-18)

**Neither direct import nor tool-invoke is viable. Use the repo's globalThis publish/subscribe pattern.**

- **Path (a) — direct programmatic `import` of goal-todo's store — UNSAFE.** pi loads extensions via **jiti** (`createJiti`, Bun `try-native` fallback — `ensure-extension-deps.ts`). A cross-ext import can resolve to a DIFFERENT module instance → writes land in a disconnected store. NOT hypothetical: `status-widget.ts` built its `globalThis.__piPowerToolStatusWidget` process-singleton precisely for this reason (doc comment explicit), and **no peer extension imports goal-todo's store today** — the repo systematically avoids it.
- **Path (b) — programmatic tool round-trip — UNAVAILABLE.** `ExtensionAPI` exposes `registerTool` (register, not invoke) + `setActiveTools`/`getAllTools` and has **no `invokeTool`/`callTool`/`executeTool`**. The only push APIs (`sendMessage`/`sendUserMessage`) trigger an agent turn (heavy, non-deterministic); `exec` runs a separate shell process (can't touch the in-process store).
- **Recommended — the established globalThis publish/subscribe pattern.** superpowers PARSES the plan + PUBLISHES the parsed result via a new seam (e.g. `globalThis.__piSuperpowersPlan: () => { goal, steps[] }`); goal-todo READS it (mirroring how it already reads `__piPlanIncomplete` / `__piPlanSummary` from wayfind at `goal.ts:985,1007`) and mutates its OWN store via its own module instance → no dual-instance risk.

**Reframe surfaced:** the coordination is **two-sided** — superpowers = publisher (parse + expose a getter); goal-todo = subscriber (read + sync its own store). So goal-todo **must gain a subscriber** (a new reader + sync on its existing hooks `session_start`/`tool_execution_end`) — a scope addition not explicit in the original destination.

**Deferred to [04 — Sync mapping](04-sync-mapping.md):** (i) pull (goal-todo reads a superpowers getter, like `__piPlanIncomplete`) vs push (goal-todo exposes a `__piTodoSync` write-seam, like `addSection`); (ii) the published signal's shape/contract; (iii) the plan→todo field mapping; (iv) stable step-ID. **Note:** goal-todo ALREADY gates `goal_complete` by reading `__piPlanIncomplete` — a directly reusable pattern for the map's `goal_complete`-gating fog.
