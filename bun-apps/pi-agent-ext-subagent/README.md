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
  // The isolated-PROCESS analog, for callers that need a clean child pi process
  spawnSubagentSubprocess,
  // The LLM-facing tool factories (peer extensions rarely construct these)
  createSubagentTool,
  createSubagentsTool,
  createSubagentRunsTool,
  type SubagentToolOptions,
  type SubagentToolDetails,
  // Durable run records
  getSubagentRunPersistence,
  type SubagentRunRecord,
  type SubagentRunStatus,
  // Watchdog (opt-in two-layer review of an implementer's diff)
  runWatchdog,
  type WatchdogResult,
} from "@repo/pi-agent-ext-subagent";
```

Everything above is **owned by this package**. A handful of
`@repo/pi-agent-ext-core-runtime` symbols (`WorkflowAgent`,
`getSubagentInFlightRegistry`, the model-tier config accessors, the rate-limiter
accessors) are ALSO re-exported here, but only as a deliberate facade for the
peers that cannot import core-runtime directly — see [the facade rule](#the-core-runtime-facade).
If your package already depends on `@repo/pi-agent-ext-core-runtime`, import
those from there instead.

| Surface | What it is | Use when |
| --- | --- | --- |
| `spawnSubagent(opts)` | Public wrapper over `WorkflowAgent.run` for one isolated child run | You are peer-extension **code** that needs a subagent (e.g. `zk_card`/`zk_ask`). Returns `{ output, failure?, usage?, budgetWarning? }` — `failure` absent means success, and `failure.kind` (`failed`/`timedout`/`turns`/`budget`) is the run's status. |
| `WorkflowAgent` | The LLM caller — a thin adapter over `createAgentSession()`. Owns no HTTP/provider path. | You need lower-level control than `spawnSubagent` (streaming history, budget hooks). |
| `spawnSubagentSubprocess(opts)` | The isolated-**process** analog of `spawnSubagent` | You need a clean child `pi` process rather than an in-process session (obsidian distill/garden, tool-gate L2 A/B). |
| `createSubagentTool` / `createSubagentsTool` / `createSubagentRunsTool` | The `subagent`, `subagents` + `subagent_runs` tool factories | You are an extension re-hosting these tools. The package's own extension already registers them; you normally do NOT call these. |
| `getSubagentInFlightRegistry()` / `getSubagentRunPersistence()` | Process-wide singletons | You are a viewer/command that must observe the SAME live + persisted runs the `subagent` tool writes. Any import path resolves to one instance — see [module identity](#module-identity--the-singletons). |
| `runWatchdog(input)` | Opt-in two-layer (LSP + model) review of an implementer's final diff | You are gating a write-heavy dispatch. Soft gate — never auto-fails a run. |
| `createWorktree` / `removeWorktree`, `WorkflowError` / `WorkflowErrorCode` | Worktree isolation + the typed error envelope | Import these from `@repo/pi-agent-ext-core-runtime`; they are no longer re-exported here (nothing reached them through this barrel). |

## The core-runtime facade

This barrel re-exports a small, fixed set of `@repo/pi-agent-ext-core-runtime`
symbols. That is not laziness — `pi-agent`, `pi-agent-ext-obsidian`,
`pi-agent-ext-file2md` and `pi-agent-ext-knowledge-card` do **not** declare
core-runtime in their `package.json`, and `bun-apps/tests/dep-guard.test.ts`
(invariant 1) rejects an undeclared `@repo` edge. For those peers this package is
the only legal path to `WorkflowAgent`, `getSubagentInFlightRegistry`, and the
model-tier accessors.

The rule, enforced by [`tests/barrel-surface.test.ts`](tests/barrel-surface.test.ts)
in both directions:

1. every core-runtime symbol re-exported from `src/index.ts` must have a named
   peer consumer recorded in that test's `FACADE_SYMBOLS`, and
2. every `FACADE_SYMBOLS` row must still be re-exported **and** still be imported
   through this barrel by the file it names.

Direction 2 is what keeps the facade from rotting: when a peer moves off the
barrel, its re-export becomes dead interface, and the guard says so instead of
letting it sit. This barrel previously carried 114 exported names of which 21
were ever imported.

## Module identity — the singletons

`getSubagentInFlightRegistry()` and `getSubagentRunPersistence()` are
module-local lazy singletons, so all observers must land on one module instance.
They do, and **no special import path is needed**: this package's
`exports["."]` maps to `./src/index.ts` (not to `dist/`), so the package root and
the `src/` subpath are the same module. `getSubagentInFlightRegistry` moreover
lives in core-runtime now, whose root likewise maps to its own `src/index.ts` —
so importing it from core-runtime, from this package's root, or from the `src/`
subpath all resolve to one registry.

[`tests/rate-limiter-cross-pkg.test.ts`](tests/rate-limiter-cross-pkg.test.ts)
pins the observable half of this: it holds the only slot of a cap-1 limiter
acquired via the core-runtime path and asserts the package-root path **blocks**
on the same budget. Behavioral, so it holds regardless of how the linker dedupes
module records.

> An earlier revision of this file instructed peers to import the singletons via
> `@repo/pi-agent-ext-subagent/src/index.ts` because "the package root resolves
> to `dist/index.js`". It does not, and never has under this `exports` map —
> `pi-agent-ext-obsidian` imports both singletons from the plain package root and
> is correct to.

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
