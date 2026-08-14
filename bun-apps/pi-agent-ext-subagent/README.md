# @repo/pi-agent-ext-subagent

Isolated single-subagent dispatch for [Pi](https://github.com/earendil-works/pi-coding-agent): the `subagent` and `subagent_runs` tools, the `WorkflowAgent` runner that drives a fresh in-memory Pi session per dispatch, the `spawnSubagent` programmatic API, and the process-wide singletons that let the `/subagents` viewer (now in this package, since PR #821) observe in-flight and completed runs. Extracted from `pi-agent-ext-workflow` as a lower-dependency library so peer extensions (`knowledge-card`, `wayfind`, `superpowers`, …) can `spawnSubagent` without dragging in the whole workflow DSL, and so the subagent tools load independently of the workflow engine.

## Public API surface

Import from the package root for **values and types** you merely use:

```ts
import {
  // Programmatic dispatch (peer-extension code path, NOT the LLM tool path)
  spawnSubagent,
  type SpawnSubagentOptions,
  type SpawnSubagentResult,
  type SpawnSubagentPrime,
  // The LLM-caller engine (thin adapter over Pi's createAgentSession)
  WorkflowAgent,
  type WorkflowAgentOptions,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentUsage,
  // The two LLM-facing tools (peer extensions rarely construct these directly)
  createSubagentTool,
  createSubagentRunsTool,
  type SubagentToolOptions,
  type SubagentToolDetails,
  type SubagentRunsToolOptions,
  // Shared singletons (SEE THE MODULE-IDENTITY RULE BELOW)
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
  type InFlightSubagent,
  type SubagentRunRecord,
  type SubagentRunStatus,
  // Agent registry / model tiers / worktrees / errors / history
  loadAgentRegistry,
  listAgentTypes,
  resolveAgentType,
  loadModelTierConfig,
  resolveTierModel,
  createWorktree,
  removeWorktree,
  WorkflowError,
  WorkflowErrorCode,
  compactAgentHistory,
  summarizeLatestAction,
} from "@repo/pi-agent-ext-subagent";
```

| Surface | What it is | Use when |
| --- | --- | --- |
| `spawnSubagent(opts)` | Public wrapper over `WorkflowAgent.run` for one isolated child run | You are peer-extension **code** that needs a subagent (e.g. `zk_card`/`zk_ask`). Returns `{ output, exitCode, stderr, timedOut, usage? }`. |
| `WorkflowAgent` | The LLM caller — a thin adapter over `createAgentSession()`. Owns no HTTP/provider path. | You need lower-level control than `spawnSubagent` (streaming history, budget hooks). |
| `createSubagentTool` / `createSubagentRunsTool` | The `subagent` + `subagent_runs` tool factories | You are an extension re-hosting these tools. The package's own extension already registers them; you normally do NOT call these. |
| `getSubagentInFlightRegistry()` / `getSubagentRunPersistence()` | Process-wide singletons | You are a viewer/command that must observe the SAME live + persisted runs the `subagent` tool writes. **Obey the module-identity rule.** |
| `createWorktree` / `removeWorktree` | Git-worktree isolation helpers | An agent definition requests worktree isolation. |
| `WorkflowError` / `WorkflowErrorCode` | Typed error envelope | Classifying a dispatch failure. |

## Module-identity rule for peer extensions (forward-compat)

`getSubagentInFlightRegistry()` and `getSubagentRunPersistence()` are **module-local lazy singletons**. For two extensions to share ONE registry instance — so the `subagent` tool's writes are visible to the `/subagents` viewer — they MUST resolve the singleton from the **same module instance**.

- ✅ **DO** import the singletons via the **`src/` subpath**:
  ```ts
  // from another extension's extensions/<x>.ts:
  import { getSubagentInFlightRegistry } from "@repo/pi-agent-ext-subagent/src/index.ts";
  ```
  This package's own extension does the equivalent relative import (`../src/index.js`), which resolves to the same `src/index.ts` module. Both land on the identical module instance → one singleton.
- ❌ **DO NOT** import the singletons via the dist root (`@repo/pi-agent-ext-subagent`) and expect the live instance. The package root resolves to `dist/index.js`; a `dist/` module and a `src/` module are NOT guaranteed to be the same JS module identity, so the two callers would each get their own lazily-initialized singleton and the viewer would see an empty registry.

The values/types in the table above (`spawnSubagent`, `WorkflowAgent`, errors, the tool factories, …) are safe to import from the package **root** — only the two singletons demand the `src/` subpath. (Since PR #821 the viewer + command live in this package, so they import the singletons via the in-package relative path. The `src/` subpath rule above is retained as forward-compat advice for any future peer extension that wants to observe runs directly — none do today.)

See `docs/adr/0001-why-extracted.md` for the full rationale and `CONTEXT.md` for the ubiquitous language.

## Token budgets

Every dispatch gets a **tier-calibrated default token ceiling** (a hard-abort fuse, measured p90 + headroom so only the runaway tail is aborted): **small = 500k**, **medium = 1.2M**, **big = 1.5M**. The tier comes from the explicit `tier` param, a reverse-map of the resolved model via `~/.pi/workflows/model-tiers.json`, or the safe `medium` fallback. An explicit per-dispatch `tokenBudget` always wins over the default; setting one explicitly is normally reserved for deliberate spend caps (see `.planning/knowledge/subagent-dispatch-budget-protocol.md`).

The defaults are adjustable at runtime via environment variables (read at call time, no caching; invalid values are silently ignored):

| Env var | Effect |
| --- | --- |
| `SUBAGENT_TOKEN_BUDGET_DISABLE=1|true` | No default budget at all (explicit `tokenBudget` still applies). |
| `SUBAGENT_TOKEN_BUDGET_SMALL` / `_MEDIUM` / `_BIG` | Replace that tier's ceiling (positive integer; applies to whichever tier the dispatch resolved to). |
| `SUBAGENT_TOKEN_BUDGET_MULTIPLIER` | Multiply the result after any absolute override (positive finite float). |

The final value is clamped to `Math.max(1, Math.floor(result))`. When the token budget is crossed the child gets a **graceful wrap-up turn** (part 2): a final-turn user message tells it to flush findings/state/artifacts to disk, exactly one more turn runs, and the next crossing aborts for real with `status:"budget"`. `spendBudget` stays a hard stop (no wrap-up) — it is a money valve; if both budgets cross at once, the hard abort wins.

## Upstream sync

This package has **dual provenance**: the package body (33 src files) was extracted from `pi-agent-ext-workflow` (#789), while the 2 watchdog files (`src/watchdog/lsp-diagnostics.ts`, `src/watchdog/repo-diff.ts`) are a selective port from `nicobailon/pi-subagents`. The watchdog ports are documented in [`docs/upstream/pi-subagents.pin.md`](docs/upstream/pi-subagents.pin.md) — consult it before any upstream sync so those ports aren't lost again.
