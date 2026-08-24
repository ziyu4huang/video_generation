# @repo/s2-agent-ext-subagent

Isolated single-subagent dispatch for [Pi](https://github.com/earendil-works/pi-coding-agent): the `subagent` and `list_subagent_runs` tools, the `WorkflowAgent` runner that drives a fresh in-memory Pi session per dispatch, the `spawnSubagent` programmatic API, and the process-wide singletons that let the `/subagents` viewer (now in this package, since PR #821) observe in-flight and completed runs. The `subagent` tool takes `background: true` for a dispatch that returns immediately (run id + `⌛ running`) and continues in-process, waking the parent with a `<task-notification>` follow-up on completion; a live background run is awaited via `list_subagent_runs {action:"wait"}` and stopped via `{action:"stop"}`. Extracted from `s2-agent-ext-ultracode` as a lower-dependency library so peer extensions (`knowledge-card`, `wayfind`, `superpowers`, …) can `spawnSubagent` without dragging in the whole workflow DSL, and so the subagent tools load independently of the workflow engine.

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
} from "@repo/s2-agent-ext-subagent";
```

Everything above is **owned by this package**. A handful of
`@repo/s2-agent-core-runtime` symbols (`WorkflowAgent`,
`getSubagentInFlightRegistry`, the model-tier config accessors, the rate-limiter
accessors) are ALSO re-exported here, but only as a deliberate facade for the
peers that cannot import core-runtime directly — see [the facade rule](#the-core-runtime-facade).
If your package already depends on `@repo/s2-agent-core-runtime`, import
those from there instead.

| Surface | What it is | Use when |
| --- | --- | --- |
| `spawnSubagent(opts)` | Public wrapper over `WorkflowAgent.run` for one isolated child run | You are peer-extension **code** that needs a subagent (e.g. `zk_card`/`zk_ask`). Returns `{ output, failure?, usage?, budgetWarning? }` — `failure` absent means success, and `failure.kind` (`failed`/`timedout`/`turns`/`budget`) is the run's status. |
| `WorkflowAgent` | The LLM caller — a thin adapter over `createAgentSession()`. Owns no HTTP/provider path. | You need lower-level control than `spawnSubagent` (streaming history, budget hooks). |
| `spawnSubagentSubprocess(opts)` | The isolated-**process** analog of `spawnSubagent` | You need a clean child `pi` process rather than an in-process session (obsidian distill/garden, tool-gate L2 A/B). |
| `createSubagentTool` / `createSubagentsTool` / `createSubagentRunsTool` | The `subagent`, `subagents` + `list_subagent_runs` tool factories | You are an extension re-hosting these tools. The package's own extension already registers them; you normally do NOT call these. |
| `getSubagentInFlightRegistry()` / `getSubagentRunPersistence()` | Process-wide singletons | You are a viewer/command that must observe the SAME live + persisted runs the `subagent` tool writes. Any import path resolves to one instance — see [module identity](#module-identity--the-singletons). |
| `getBackgroundRunManager()` / `wireBackgroundDeliverer(pi)` | The background roster (claim/track/release, `SUBAGENT_MAX_BACKGROUND` cap) + the followUp task-notification wake wiring | You host the tools yourself and want background dispatch + parent wake in your own host. The package's own extension entry calls `wireBackgroundDeliverer(pi)` at load. |
| `runWatchdog(input)` | Opt-in two-layer (LSP + model) review of an implementer's final diff | You are gating a write-heavy dispatch. Soft gate — never auto-fails a run. |
| `createWorktree` / `removeWorktree`, `WorkflowError` / `WorkflowErrorCode` | Worktree isolation + the typed error envelope | Import these from `@repo/s2-agent-core-runtime`; they are no longer re-exported here (nothing reached them through this barrel). |

## The core-runtime facade

This barrel re-exports a small, fixed set of `@repo/s2-agent-core-runtime`
symbols. That is not laziness — `s2-agent`, `s2-agent-ext-obsidian`,
`s2-agent-ext-file2md` does **not** declare core-runtime in its
`package.json`, and `bun-apps/tests/dep-guard.test.ts` (invariant 1) rejects an
undeclared `@repo` edge. For that peer this package is the only legal path to
`WorkflowAgent` and the model-tier accessors. (`getSubagentInFlightRegistry`
is no longer re-exported here: obsidian, knowledge-card and hermes-memory all
declare core-runtime directly — the portable base set forbids ext→ext edges,
so the registry comes from the host module, not through this barrel.)

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
> `@repo/s2-agent-ext-subagent/src/index.ts` because "the package root resolves
> to `dist/index.js`". It does not, and never has under this `exports` map —
> `s2-agent-ext-obsidian` imports both singletons from the plain package root and
> is correct to.

See `docs/adr/0001-why-extracted.md` for the full rationale and `CONTEXT.md` for the ubiquitous language.

## Token budgets

Every dispatch gets a **tier-calibrated default token ceiling** (a hard-abort fuse, measured p90 + headroom so only the runaway tail is aborted): **small = 500k**, **medium = 1.2M**, **big = 1.5M**. The tier comes from the explicit `tier` param, a reverse-map of the resolved model via `~/.pi/workflows/model-tiers.json`, or the safe `medium` fallback. An explicit per-dispatch `tokenBudget` always wins over the default; setting one explicitly is normally reserved for deliberate spend caps (see `.planning/knowledge/subagent-dispatch-budget-protocol.md`).

On top of the tier ceiling, a dispatch that omits **all three** of `tokenBudget`/`maxTurns`/`timeoutMs` gets a **role-aware envelope** (`ROLE_AWARE_DISPATCH_BOUNDS`, rebalanced 2026-08-18 from the 200-run dispatch ledger): **recon** (read-only toolset) = 120k tokens / 12 turns / 5 min; **writer** (write-capable or unrestricted) = 400k / 28 turns / 20 min. Any explicit bound opts the WHOLE envelope out — partial mixing never happens. Batch children in the `subagents` tool always run recon bounds.

Programmatic callers that use `spawnSubagent` directly (not the LLM tools) bypass the tool seam where envelopes apply — use the exported **`roleAwareDirectCall(role, task, logId)`**: it applies the role's caps AND appends the abort-safety footer (the as-you-go `/tmp/subagent-runs/<logId>.md` progress-log mandate) atomically at call time; `SUBAGENT_TOKEN_BUDGET_DISABLE=1` strips both. Children at 12+ turns cross the footer gate by design — turns-limit deaths are the top killer and the as-you-go log is what makes a budget death recoverable.

To recalibrate: `bun scripts/runs-stats.ts` emits per-status counts plus token/turns medians straight from `~/.pi/subagents/runs` — bounds move from those medians, never intuition (procedure: `superpowers/skills/dispatch-recovery` Calibration section).

The defaults are adjustable at runtime via environment variables (read at call time, no caching; invalid values are silently ignored):

| Env var | Effect |
| --- | --- |
| `SUBAGENT_TOKEN_BUDGET_DISABLE=1|true` | No default budget at all (explicit `tokenBudget` still applies). |
| `SUBAGENT_TOKEN_BUDGET_SMALL` / `_MEDIUM` / `_BIG` | Replace that tier's ceiling (positive integer; applies to whichever tier the dispatch resolved to). |
| `SUBAGENT_TOKEN_BUDGET_MULTIPLIER` | Multiply the result after any absolute override (positive finite float). |
| `SUBAGENT_MAX_TURNS` | Replace the role envelope's turn cap (positive integer; applies only when the envelope applies — explicit params still opt out entirely). |
| `SUBAGENT_TIME_BUDGET_DISABLE=1\|true` | Strip ONLY the role envelope's wall-clock bound — token/turn caps stay applied. At the tool seam the 15-min `DEFAULT_TIMEOUT_MS` still lands; at direct-call seams wall-clock is then unbounded (token/turn caps remain the runaway bound). Not the whole-envelope escape — that is `SUBAGENT_TOKEN_BUDGET_DISABLE`. |
| `SUBAGENT_TIME_BUDGET_RECON` / `_WRITER` | Replace that role's wall (positive integer, ms; applies only when the envelope applies). |
| `SUBAGENT_TIME_BUDGET_MULTIPLIER` | Multiply the role wall after any absolute override (positive finite float; floored to ≥1 ms). |
| `SUBAGENT_MAX_BACKGROUND` | Concurrent background-dispatch ceiling (default 4; at capacity a background dispatch fails fast instead of queueing — wait for or stop a running one, or raise the cap). |

The final value is clamped to `Math.max(1, Math.floor(result))`. When the token budget is crossed the child gets a **graceful wrap-up turn** (part 2): a final-turn user message tells it to flush findings/state/artifacts to disk, exactly one more turn runs, and the next crossing aborts for real with `status:"budget"`. `spendBudget` stays a hard stop (no wrap-up) — it is a money valve; if both budgets cross at once, the hard abort wins.

### Environment-hints dispatch footer

Recurring host/repo environment facts (macOS has no GNU `timeout`; never `git add -A`; subshell-scoped `cd`; English artifacts) live in a **user-owned hints file** — `~/.pi/subagents/hints.md`, overridable via `PI_SUBAGENT_HINTS_FILE` — and are auto-appended to every spawned task as a `--- environment hints (auto-appended by the dispatch layer — obey; don't restate) ---` block, mirroring the abort-safety footer. The file's **presence is the on/off switch** (no extra env flag): absent/unreadable/blank → no footer, and read failure is silently ignored so a broken hints file can never break dispatches. Content is trimmed and **capped at 2000 chars** (`[hints truncated]` sentinel). It is applied at two seams, both in `subagent-tool-run.ts`, always **before** the abort-safety footer (env facts are working context; abort-safety gets the last word): `buildSpawnOptions` (the tool seam — SPAWNED task only, `params.task` stays raw for the taskSignature circuit-breaker) and `roleAwareDirectCall` (both the applied and not-applied branches — hints are independent of the budget envelope).

## Upstream sync

This package has **dual provenance**: the package body (33 src files) was extracted from `s2-agent-ext-ultracode` (#789), while the 2 watchdog files (`src/watchdog/lsp-diagnostics.ts`, `src/watchdog/repo-diff.ts`) are a selective port from `nicobailon/pi-subagents`. The watchdog ports are documented in [`docs/upstream/pi-subagents.pin.md`](docs/upstream/pi-subagents.pin.md) — consult it before any upstream sync so those ports aren't lost again.
