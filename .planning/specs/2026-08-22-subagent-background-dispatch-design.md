# Subagent background dispatch + task notifications — design

Date: 2026-08-22
Status: approved design (brainstorm session), pre-implementation
Scope owner: `bun-apps/s2-agent-ext-subagent`
Upstream intent: close the largest gap to the claude-code Agent tool — background dispatch with parent auto-wake on completion (the `run_in_background` + task-notification + TaskOutput/TaskStop shape).

## Decisions (from the brainstorm interview)

1. **Primary goal**: background dispatch + completion notification. Named-agent continuation (SendMessage to an agent), fork-with-parent-context, and shared team task lists are explicit follow-ups — background + notification is their shared foundation.
2. **Process model**: in-process. Background agents run in the host s2-agent process via the existing `WorkflowAgent` runner. Closing the TUI kills them (same as claude-code session-scoped agents). The existing `detach-run.ts` subprocess path stays untouched as the escape hatch.
3. **Tool surface**: extend the existing tools — no new tool names. `subagent` gains `background?: boolean`; `subagent_runs` gains `wait` / `stop` subcommands (the TaskOutput / TaskStop analogs).
4. **Notification semantics**: auto-wake. On completion the extension delivers a `<task-notification>` message via `pi.sendMessage(msg, { deliverAs: "followUp" })` — pi queues it while the parent turn is busy and delivers when idle (the seam `s2-agent-ext-btw` already uses for handoff injection).
5. **TUI scope**: extend the existing surfaces only. The CC-style dock (`s2-agent-ext-task/src/subagents/dock.ts`) and the `/subagents` viewer already render `foreground:false` runs — background runs inherit them nearly for free. Interactive FleetView-grade dashboards are a follow-up effort.

## Architecture

```
subagent tool (background:true)
   |  execute(): build spawn request (same path as today) -> dispatchChild(...)
   |             does NOT await -> hands the promise to the manager -> returns immediately
   v
BackgroundRunManager (module-level singleton in src/background-run-manager.ts;
                      same singleton idiom as the two registries)
   |- Map<runId, { promise, spec }>  (background roster; the in-flight registry owns
   |                                  observable state, the manager owns post-completion action)
   |- on completion: format <task-notification> -> pi.sendMessage(..., { deliverAs: "followUp" })
   |- stop(runId): fires the registry's per-child abort lever
```

Unchanged by design: `dispatchChild` (the single run-driver — "owns the run, not the request"; we change only the request semantics), the `spawnSubagent` programmatic API (not extended this round), budget envelopes / hints footer (applied to background runs exactly as to foreground), and the persistence format (records gain one backward-compatible `background?: true` field).

## Lifecycle / data flow

```
parent turn (model calls subagent background:true)
  1. execute(): build spawn request -> dispatchChild (same path; envelope/hints/footer unchanged)
  2. registry.start({ id, foreground:false, background:true, abort, task, ... })
  3. execute returns: { id, status:"running", message:"dispatched to background;
     completion will be delivered as a follow-up message" }
  4. parent turn continues/ends - the background run is unaffected
  ------------------ (async) ------------------
  5. child completes -> dispatchChild's existing teardown (persistence write, registry terminal state)
  6. manager formats the task-notification -> pi.sendMessage(..., { deliverAs: "followUp" })
  7. parent idle -> wakes on the notification; busy -> pi queues it automatically
```

**Obtaining `pi`**: `execute()` has long returned when the child finishes, so the extension entry (`extensions/subagent.ts`) caches the `ExtensionContext` at `session_start` (the btw idiom) and the manager reads `sendMessage` from that cache. Session end = in-process runs die with the process; there is no notify-the-dead window by construction.

**Task-notification format** (a user message to the parent):

```
<task-notification>
Background subagent run ${id} completed.
- agent: ${agent ?? "default"}  model: ${resolvedModel}
- status: done | failed | timedout | budget | aborted
- usage: ${tokensIn}in / ${tokensOut}out ($${cost})
- result preview: ${first ~600 chars of output, truncated with a sentinel}
Full output: call subagent_runs with subcommand "get", id "${id}".
</task-notification>
```

`failure.kind` maps 1:1 onto status (existing Failure union; no new vocabulary). The ~600-char preview lets the parent decide "use as-is" vs "fetch full output" without flooding its context when several notifications land together.

**`wait` / `stop` semantics**

- `wait <id> [--timeout-ms N]` (default 30000, cap 300000): blocks until the run is terminal or the timeout elapses. Terminal -> returns status + full result (background converted back to synchronous). Timeout -> returns `{ status:"running", elapsedMs }` and is NOT an error. Works on already-terminal foreground runs too (immediate return).
- `stop <id>`: fires the child's AbortController via the registry abort lever -> the run ends with status `aborted` and **still sends the notification** (the parent must learn that a run it stopped actually stopped). Unknown id / already-terminal -> structured error message, no exception.

**Notification-delivery failure**: if `sendMessage` itself throws — record persistence and registry terminal state as usual, degrade silently (no retry, no crash). The next `subagent_runs list` still shows the result.

## Abort & lifecycle semantics

**Turn decoupling** (the core risk point; `child-dispatch.ts` owns the parent-turn-signal fan-in):

- A background dispatch passes a never-firing stub controller as `externalSignal` (instead of the parent turn's signal). Effect: parent turn ending, or the user Esc-aborting the parent turn, never kills the background run — matching claude-code's "background agents survive the turn".
- The three legitimate ways to kill a background run (all existing): `subagent_runs stop` (new), the `/subagents` viewer / dock x-key (per-child abort lever), and the child's own timeout / token-budget fuse (15 min / tier ceiling — not relaxed for background).
- Unhandled-rejection guard: the manager `.catch()`es every background promise (including post-stop terminal returns).

**Session boundary** (stated consequence of the in-process model, deliberately unmitigated):

- TUI closed = background runs die with the process. No notification, no orphan record (persistence only ever records completed runs — identical to today's foreground mid-flight death behavior).
- The `session_start`-cached ctx is per-session; the manager singleton is overwritten on re-entry (the prior session's runs died with its process — no residue).

**Concurrency cap**:

- New env `SUBAGENT_MAX_BACKGROUND` (default 4): concurrent background-dispatch ceiling. At capacity -> immediate structured error (`background slot limit reached; N running — wait or stop one`); no queueing. Foreground dispatch rate-limiting is unaffected; background runs also consume the existing limiter's budget (both gates must pass).
- The `subagents` batch tool does NOT gain a `background` parameter — batch children are recon-envelope short runs; backgrounding them is low-value (YAGNI).

**Registry marker**: background runs register with `foreground:false` + a new `background:true` field (viewer badge; distinct from the existing `detached` — detached = mid-flight handoff to a subprocess, background = background from birth, in-process).

## TUI

Already exists and is inherited as-is (`s2-agent-ext-task/src/subagents/` — the CC-style subagent TUI):

| claude-code analog | Existing implementation |
| --- | --- |
| live background status row | `dock.ts` — above-editor dock rendering `registry.views({ foreground: false })`; a background run appears the moment it registers `foreground:false` — zero changes |
| stop one agent from the TUI | dock `x` (arm) -> `y` (confirm) per-run abort state machine, via the registry abort lever |
| completion toast | `notify.ts` — diff-driven transient completion line (`✓ <actor> <status> · <elapsed>s`) + one bell; fires automatically on a background run's terminal transition |
| multi-run navigation | dock `j/k` scroll, expand, open-viewer |
| follow live stream | the `/subagents` viewer's `follow` mode (reads the in-flight registry's history stream) — applies to background runs unchanged |

Remaining delta (small):

1. `notify.ts` gains one symmetric rule: a `background:true` run's first appearance in the dock renders a `dispatched → background · <actor>` transient line (same diff mechanism, ~10 lines) — today only `detached → background` (mid-flight) exists.
2. `/subagents` viewer: `bg` badge on rows (reads `background:true`), alongside the existing `detached` badge.
3. NOT built here: interactive FleetView dashboards, sending messages to a running agent from the TUI — follow-up effort (the "agent-team TUI" from the original ask takes shape there).

Answer to the original "can we build a subagent TUI on pi-tui": yes — and two layers already exist (the dock + the `/subagents` viewer); this effort only adds the final background-semantics piece on top.

## Testing

Unit tests (this package's existing fake/seam conventions; 3 new files + 2 extended):

| Test | Verifies |
| --- | --- |
| `tests/background-run-manager.test.ts` (new) | immediate dispatch return with id; completion -> `sendMessage(msg, {deliverAs:"followUp"})` receives a correctly-formatted task-notification (all failure.kind status mappings); `stop` goes through the abort lever; `SUBAGENT_MAX_BACKGROUND` at-capacity structured rejection; `sendMessage` throwing -> silent degradation without retry; every promise caught (no unhandled rejections) |
| `tests/subagent-tool.test.ts` (extended) | with `background:true` the registry receives `foreground:false` + `background:true` + the stub signal (fire a fake turn signal; the child survives); omitting the parameter = today's behavior byte-for-byte (existing tests are the regression net) |
| `tests/subagent-runs-tool.test.ts` (extended) | `wait`: terminal return / timeout-returns-running-without-error / immediate return on completed runs; `stop`: structured errors for unknown id and terminal runs |
| `s2-agent-ext-task` `notify.test.ts` (extended) | `background:true` first appearance -> `dispatched → background` transient line (dock otherwise zero-change; its existing tests keep passing) |
| `tests/subagent-viewer.test.ts` (extended) | `bg` badge rendering |

Integration smoke (one, echo-agent grade): background-dispatch a minimal task -> do not await -> `subagent_runs wait` returns `done` -> assert the followUp notification reached the fake pi. No new standing E2E (local_ci ≤ 5 min budget).

Gates: the package's canonical `bun run test` (`check` (biome) + `build` (tsc) + `test:unit`) plus `bun run --cwd bun-apps/s2-agent typecheck` cross-package coverage (the core-runtime `background` field and the task-ext notify rule are both under its jurisdiction).

## Documentation (shipped with the PR)

- `CONTEXT.md` language entries: **Background dispatch** (background from birth, in-process, `foreground:false`; explicitly contrasted with **Detached** = mid-flight subprocess handoff) and **Task notification** (followUp wake semantics).
- README: `background` / `wait` / `stop` rows in the tool tables; `SUBAGENT_MAX_BACKGROUND` in the env-var table.
- `docs/adr/0007-background-dispatch-turn-decoupling.md`: the stub-signal decision — it deliberately violates the existing "the child dies with the turn" intuition and deserves a recorded why.

## Explicit follow-ups (out of scope)

- Named-agent continuation (SendMessage to a finished agent with its context intact).
- Fork (subagent inheriting the parent's full context).
- Shared team task list + long-lived autonomous agents ("agent team").
- Interactive FleetView-grade TUI; messaging a running agent from the TUI.
