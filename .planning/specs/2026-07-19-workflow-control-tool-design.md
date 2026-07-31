# pi-agent-ext-workflow — model-callable run control + subagent abort-signal fix (design)

**Date:** 2026-07-19
**Branch (next):** off `origin/main`
**Owner:** Ziyu Huang

## 1. Goal

`bun-apps/pi-agent-ext-workflow` already mirrors Claude Code closely: `subagent`
and `workflow` tools auto-activate every turn, the `workflow` tool backgrounds
by default with a live task panel + a full-screen `/workflows` navigator
(keyboard `x`/`p`/`r` to stop/pause/restart), and `WorkflowManager.stop()`
correctly calls a real `AbortController.abort()` — not a cosmetic status flag.

Two concrete gaps remain against Claude Code's actual tool surface (verified
against this environment's own `TaskStop`/`TaskOutput`/`TaskList`/`Monitor`
tool schemas, plus a side-by-side read of `../pi-subagents` and
`../pi-subagents-lite`, two mature sibling implementations of the same
"model-controlled subagent" pattern for `pi`):

1. **The control plane for background workflow runs is human-only.**
   `/workflows stop|pause|resume|status|list` exist solely as a slash command
   (`workflow-commands.ts`) — there is no tool the model itself can call. If a
   user says "cancel that background run" in plain language, the assistant has
   no way to act on it; it can only ask the human to type the command.
   Claude Code's `TaskStop`/`TaskList` are tools the model calls directly.
   `pi-subagents`' `subagent({action:"stop"|"status"})` and
   `pi-subagents-lite`'s `StopAgent`/`AgentStatus` both independently converge
   on the same requirement.

2. **`subagent` tool ignores the runtime abort signal.**
   `subagent-tool.ts`'s `execute(_toolCallId, params, _signal, ...)` never
   forwards `_signal` into `spawnSubagent()`. Interrupting that tool call
   (Ctrl+C in the pi TUI) does not actually cancel the child LLM session —
   it keeps running server-side. This is inconsistent with the `workflow`
   tool's foreground path, which correctly threads `externalSignal: signal`
   into `manager.runSync()`.

This design closes both gaps with the smallest change that reuses existing
machinery. It does **not** import chains/`.chain.json` fan-out, the watchdog
reviewer, per-agent persistent memory, worktree management UI, or permission-
system integration from `pi-subagents` — all out of scope for this round.

## 2. Scope

- **New tool**: `workflow_control`, one multiplexed tool with an `action`
  enum (matches `pi-subagents`' `subagent({action})` shape — token-cheaper
  than three separate tool schemas, and consistent with this package's
  existing per-turn token-cost discipline in `workflow-tool.ts`).
- **Bugfix**: `spawn-subagent.ts` + `subagent-tool.ts` — thread the runtime
  abort signal through, with a correctness guard so an external abort never
  triggers the existing transient-failure retry.
- **Surface**: `pi-agent-ext-workflow/src/workflow-control-tool.ts` (new),
  `spawn-subagent.ts`, `subagent-tool.ts`, `extensions/workflow.ts`
  (registration), `CONTEXT.md` + `PRD.md` (docs). Plus tests.
- **Out of scope**: no `background` param added to `subagent` tool (stays
  synchronous by design — see §3.3); no changes to the TUI navigator or task
  panel (already correct); no changes to `WorkflowManager.stop()` internals
  (already correctly wired to a real `AbortController`).

## 3. Design

### 3.1 `workflow_control` tool

```ts
workflow_control({
  action: "stop" | "pause" | "resume" | "status" | "list" | "wait",
  runId?: string,       // required for stop/pause/resume/status/wait; ignored by list
  timeoutMs?: number,   // wait only; default 30_000, clamped to [1_000, 300_000]
})
```

- `stop` / `pause` / `resume` call `manager.stop(runId)` / `pause(runId)` /
  `resume(runId)` directly — **zero new logic**, same methods the slash
  command already calls. On an unknown/non-running `runId` for `stop`, the
  error text lists currently-running run IDs (borrowed from
  `pi-subagents-lite`'s `StopAgent`, which does the same so the model can
  self-correct without a follow-up `list` call).
- `status` / `list` reuse the existing render helpers verbatim
  (`renderWorkflowText(recomputeWorkflowSnapshot(...))` for a live run,
  `renderPersistedStatus` for a finished one, `manager.listRuns()` for the
  list) — the model sees **exactly** the same formatting a human sees via
  `/workflows status|list`. Both results end with a one-line nudge borrowed
  from `pi-subagents-lite`'s `AgentStatus`: prefer waiting for the automatic
  completion delivery over polling status repeatedly.
- `wait` is new behavior, modeled on `pi-subagents`' `subagent_wait`: when
  the model backgrounded a run but the *current turn* now needs its result
  before continuing (rather than yielding control and getting notified
  later), `wait` blocks up to `timeoutMs` by subscribing to the manager's
  `complete`/`error`/`stopped` events filtered to `runId` (`Promise.race`
  against a timeout), then unsubscribes. On timeout it returns the current
  snapshot (same shape as `status`), not an error — so a slow run degrades
  to "still running" instead of throwing.
- **Registration**: alongside `workflowTool`/`subagentTool`/`workflowHelpTool`
  in `extensions/workflow.ts`, added to `activateWorkflowTools()`'s always-
  active list — same per-turn activation pattern, no new lifecycle hook.
- **Scope boundary**: `workflow_control` only knows about `WorkflowManager`
  runs (i.e. runs started via the `workflow` tool with `background: true`).
  A `subagent` tool call has no run identity to control — "killing" it is the
  abort-signal path in §3.2, not this tool. This split mirrors the codebase's
  existing division: `workflow` owns tracked/resumable runs, `subagent` owns
  one-shot synchronous dispatch.

### 3.2 `subagent` abort-signal fix

`spawn-subagent.ts`:

```ts
export interface SpawnSubagentOptions {
  // ...existing fields...
  externalSignal?: AbortSignal;
}
```

Inside `spawnSubagent()`'s `tryOnce()`, chain the external signal into the
per-attempt `AbortController` the same way `workflow-manager.ts` already does
for the foreground `workflow` path:

```ts
if (opts.externalSignal?.aborted) ac.abort();
else opts.externalSignal?.addEventListener("abort", () => ac.abort(), { once: true });
```

`subagent-tool.ts`: rename `_signal` → `signal`, pass
`spawn({ ...opts, externalSignal: signal })`.

**Correctness guard (the actual bug to avoid introducing):** `classifyError()`
currently treats any `AbortError`-shaped failure as `transient: true` (eligible
for the existing single retry). If an *external* abort (Ctrl+C) is classified
transient, `spawnSubagent()` would retry — running the subagent a second time
right after the user tried to cancel it. Fix: after the first attempt, gate
the retry decision on the external signal, not just `transient`:

```ts
const first = await tryOnce();
if (first.result.exitCode === 0 || !retry || !first.transient) return first.result;
if (opts.externalSignal?.aborted) return first.result;   // never retry a user-requested cancel
return (await tryOnce()).result;
```

### 3.3 Why `subagent` stays synchronous (no `background` param)

Considered and rejected for this round: giving `subagent` a `background`
option backed by `WorkflowManager.startInBackground()` (wrapping the single
call in a minimal one-agent script) so both tools share one run-tracking
system. Rejected because it's a materially bigger change (new code path in
`subagent-tool.ts`, new tests, a `runId` now exists for something that
previously didn't) for a need not established in this round — `subagent`'s
own docstring is explicit that it's "a single focused task, report back."
Revisit if real usage shows the ceremony of wrapping a one-off dispatch in a
`workflow` script is actually a friction point.

## 4. Error handling

- `stop`/`pause`/`resume`/`status`/`wait` with an unknown `runId`: clear error
  text, and for `stop` specifically, lists current running IDs (§3.1).
- `wait` timeout: not an error — returns the live snapshot so the model can
  decide to `wait` again, fall back to `status`, or yield control.
- External abort during `subagent`: no retry (§3.2); the tool call itself
  ends however the pi runtime normally ends an aborted tool call (no new
  behavior introduced here beyond correctly reacting to the signal).

## 5. Testing

Extends existing files/patterns, no new test infrastructure:

- `tests/spawn-subagent.test.ts` — external-signal abort case; regression
  test asserting an externally-aborted call does **not** retry (the core bug
  this design must not introduce).
- `tests/subagent-tool.test.ts` — asserts the tool's `signal` param reaches
  `spawn()` as `externalSignal`.
- New `tests/workflow-control-tool.test.ts` — one case per action, using the
  same injected-manager mock style as `tests/workflow-tool.test.ts`; `wait`
  covers both the resolves-before-timeout and the times-out-returns-snapshot
  paths.

## 6. Docs

- `CONTEXT.md`: add a `workflow_control` term under "Execution lifecycle",
  cross-referenced against the existing `/workflows` command entry to make
  the human-surface vs. model-surface split explicit in the ubiquitous
  language.
- `PRD.md`: add a row to the Tools/Commands table.
