# Core-Task Loop 3 — `/loop` Process Loop

**Date:** 2026-07-26
**Status:** Design — pending implementation plan
**Package:** `bun-apps/pi-agent-ext-core-task`
**Effort branch:** `docs/core-task-loop-3-design`
**Lineage:** Clean-room port of the metric/metricless process loop from `pi-goal-list-loop-audit` ("Loop 3"), adapted to core-task's modular structure and reusing its existing liveness infrastructure.

## 1. Motivation

core-task today has:

- **Loop 1** (`/goal`) — a bounded *achievement* loop: the agent works until it calls `goal_complete`, gated by an isolated completion auditor.
- **Loop 2** (`/list`) — a queue of goals; the head auto-activates.

It lacks a **process loop** — open-ended work with *no finish line*: continuous hardening, ever-improving specs, metric optimization. The audit project solved this as **Loop 3** (`/loop`). This spec ports an MVP of Loop 3 into core-task.

**Why now.** core-task is on an active hardening arc (#814 heartbeat/backoff/repetition → #818 isolated auditor → #826 `/list`). Loop 3 is the next in-trajectory step and reuses the infra those PRs landed. It is also the single most distinctive piece of the audit project not yet ported.

## 2. Goals (MVP)

- `/loop start "<target>"` in **metric mode** (`measure=<cmd>`) and **metricless** ("Sisyphus") mode.
- **Orchestrator-run measure** — the extension runs the user's shell command after every turn; the agent never self-reports a number.
- **Bounds**: `max` iterations, `time`, `tokens`, and (metric) `plateau`.
- **`HYPOTHESIS:` line** logged per iteration (auditable history).
- Reuse existing `backoff.ts`, `repetition.ts`, heartbeat, wedge alert, persistence, status-widget.

## 3. Non-goals (deferred — each gets its own spec)

- `propose_loop_refine` (living spec — mid-loop target/measure sharpening).
- `/loop respec` (reconcile against a root `SPEC.md`).
- `branch=1` scratch-branch mode (improve-commit / regress-`git reset`).
- **Cross-session scheduling / cron** — neither core-task nor the audit project has it; a deliberate non-goal of the audit project ("no daemon, no remote control") and out of scope here. See §10.

## 4. Architecture

**New module `src/loop/`** (sibling to `goal/`, `todo/`, `plan/`, `ask-user/`):

```
src/loop/
  loop.ts            # subsystem entry: registers /loop command + loop-tick + agent_end integration
  loop-state.ts      # LoopState type + PURE state helpers (zero pi import):
                     #   create / applyMeasurement / applyMetriclessTick / isPlateau / isBoundedStop
  loop-metric.ts     # runMeasure(pi, cmd, cwd) via pi.exec + parseMetric (last numeric token)
  loop-commands.ts   # /loop start|stop|status parsing (pure, mirrors goal/commands.ts)
  __tests__/         # unit tests for the pure modules
```

**Integration points:**

- `goal.ts` `agent_end` hook gains a top-of-handler branch: `if (loopState.active) { await runLoopTick(...); return; }`. A live loop drives the continuation instead of the goal path.
- **Loop ⇔ goal mutual exclusion**: `/loop start` is rejected while a goal is active (and vice-versa), with a guiding message. This is the audit project's deliberate goal-vs-loop split (achievement vs process).
- `state.ts`: a `loopState` field (sibling to `goalState`), same singleton + persistence pattern.
- `core-task.ts` (factory): import + register the loop subsystem alongside goal/todo.

**Reuse:** `backoff.ts`, `repetition.ts` (imported as pure helpers), the shared status-widget (new `loop` section), `extensionApi.appendEntry("loop-state", …)` persistence.

**Data-flow one-liner:** `/loop start` → create LoopState → agent runs a turn → `agent_end` branches into loop tick → (metric) run measure / compare bestValue / log ledger → decide continue/plateau/bounded-stop → send continuation (or stop).

## 5. Data model — `LoopState`

MVP shape (audit project's `LoopState` minus `refinements[]` and branch fields):

| Field | Type | Notes |
|---|---|---|
| `id` | string | `randomUUID()` |
| `target` | string | the process target, e.g. `"harden security"` |
| `mode` | `"metric" \| "metricless"` | `measure=` present ⇒ metric |
| `measureCmd` | string? | shell command (metric only) |
| `direction` | `"higher" \| "lower"` | which way is "better", default `higher` (metric only) |
| `iteration` | number | +1 per tick |
| `maxIterations` | number | 0 = unbounded |
| `timeLimitMs` | number? | wall-clock bound |
| `tokenBudget` / `tokensUsed` | number? | spend bound (reuses goal's usage accounting) |
| `bestValue` / `lastValue` | number? | best seen / last (metric only) |
| `plateauWindow` / `stallCount` | number | consecutive non-improvement cap (default 5) / current |
| `history` | `LoopMeasure[]` | per-iteration record |
| `startedAt` | number | epoch ms |
| `active` | boolean | |
| `stopReason` | string? | `user` \| `max` \| `time` \| `tokens` \| `plateau` \| `measure-error` \| `repetition` \| `error` |

**`LoopMeasure`** (one history entry): `{ iteration, at, value?, hypothesis, verdict }`, `verdict = improved \| plateau \| regressed \| metricless`.

`history` is capped (FIFO, last ~50 entries) to bound memory/persistence for long metricless runs.

**Lifecycle:** `active → stopped` (MVP has no `paused`). Transient turn errors reuse goal's `provider_retry`/`compaction_retry` classification — the loop *stays active* and recovers; only unrecoverable errors or stalls transition to `stopped`.

**Persistence:** `extensionApi.appendEntry("loop-state", { loop })` (deep-cloned, like goals); reconstructed on `session_start`/`session_compact`.

## 6. Commands — `/loop`

```
/loop start "<target>" [measure=<cmd>] [direction=higher|lower] [max=N] [time=<Hh|Nm>] [tokens=Nk] [plateau=N]
/loop stop
/loop status
```

- `measure=` present ⇒ **metric**; absent ⇒ **metricless** (Sisyphus).
- `max=0`/omitted ⇒ unbounded (bounded only by time/tokens/stop; typical for metricless).
- `time=2h`, `tokens=200k` reuse goal's existing parsers.

## 7. Control flow — the loop tick

`runLoopTick` (entered from the `agent_end` branch when `loopState.active`):

1. **Extract last turn** — `findFinalAssistantMessage` → text + stopReason + usage; accumulate `tokensUsed`.
2. **Parse HYPOTHESIS** — scan assistant text for a line beginning `HYPOTHESIS:` → store as this iteration's `history[].hypothesis` (else `"(no hypothesis)"`).
3. **Classify transient errors** — aborted/error → goal's `isRetryableGoalInterruption` → set `loopRecovery`, stay active, return (let pi retry / `session_compact` resume). Unrecoverable → `stop("error")`.
4. **Metric mode** — `runMeasure` via `pi.exec("bash", ["-c", cmd], { cwd, timeout: MEASURE_TIMEOUT_MS })` → `parseMetric(stdout)` → `value`.
   - **null/failure**: logged, does *not* count toward plateau; ≥3 consecutive nulls ⇒ `stop("measure-error")` (prevents a broken measure from silently looping forever, and a flaky measure from falsely tripping plateau).
   - **value**: compare to `bestValue` per `direction` → `verdict = improved | plateau | regressed`; `improved` resets `stallCount=0` and updates `bestValue`/`lastValue`, otherwise `stallCount++`. Append to `history`.
   - **first measurement** establishes the baseline (`bestValue = value`, `verdict = "improved"`); it does not count as a stall.
5. **Metricless mode** — no measure, `verdict="metricless"`, log `iteration`+`hypothesis`. (No plateau concept; bounds + anti-repetition only.)
6. **Bounds check** (in order, first hit stops): `iteration ≥ maxIterations` (if max>0) ⇒ `stop("max")`; elapsed ≥ `timeLimitMs` ⇒ `stop("time")`; `tokensUsed ≥ tokenBudget` ⇒ `stop("tokens")`; metric `stallCount ≥ plateauWindow` ⇒ `stop("plateau")`.
7. **Not stopping ⇒ continue** — apply **anti-repetition** (reuse `repetition.ts`: fingerprint each iteration's text/tool-results; if stuck, swap in an intervention prompt) → build continuation prompt → `pi.sendUserMessage(prompt, { deliverAs: "followUp" })`. Reuse goal's continuation-dedupe marker so one `agent_end` never sends two continuations.
8. **Stop handling** — set `active=false`, write `stopReason`, persist, clear `loopState`, notify, append a final `history` entry.

**Continuation-prompt contract** (shared metric/metricless skeleton): the next turn *must* begin with `HYPOTHESIS: <intended change>`, make exactly *one* improvement attempt; metric mode additionally forbids self-reporting numbers ("the orchestrator measures").

## 8. Error handling & liveness

- **Heartbeat generalization (key reuse).** The existing 15s heartbeat + 30min wedge alert currently supervise only a goal. Generalize the predicate to `supervising = goalState.active || loopState.active` — *one* liveness layer supervises whichever driver is active (mutual exclusion guarantees at most one). On re-fire it dispatches the correct continuation. The 1s `statusRefreshTimer` also covers loop elapsed. This is the only change to `goal.ts` beyond the `agent_end` branch (small, bounded).
- `pi.exec` measure timeout (`MEASURE_TIMEOUT_MS`, e.g. 60s) ⇒ treated as null ⇒ measure-error path.
- Continuation send failure ⇒ `stop("error")` (never silently hang).
- Anti-repetition ladder terminal ⇒ `stop("repetition")`.
- Every stop is persisted with `stopReason`, notified, and shown in the widget.

## 9. UI

Shared composite status-widget gains a `loop` section (order 2, after todo):

- metric: `⟳ loop #<iter> · best=<val> · stall=<n>/<plateau> · <dir>`
- metricless: `⟳ loop #<iter> (metricless) · <tok>/<budget>`

On stop: a goal-style completion flash (mirror `overlay.ts`, add a `loop` variant or lightly generalize). Kept to one status line + stop flash — no over-engineering.

## 10. Out of scope — cron / scheduled execution

Claude Code's "cron-like" capability is **Routines** (cloud, survives a closed laptop; triggers: cron/API/GitHub). **Neither core-task nor the audit project has it** — both are *session-bound reactive loops* (`agent_end` continuation + a heartbeat for within-session liveness). The audit project explicitly lists "no daemon, no remote control, no multi-machine" as a non-goal. Adding true scheduling is a separate, larger effort (daemon / OS scheduler / cloud runner) and is **not** part of this spec. The within-session heartbeat (§8) is the closest in-process analog and is already present.

## 11. Testing

- **Pure unit tests** (zero pi import, plain node — mirror `shield.ts`/`list.ts`/`backoff.ts`): `loop-state.ts` (create/applyMeasurement/applyMetriclessTick/isPlateau/isBoundedStop/transitions), `loop-metric.ts` `parseMetric` (last-number edge cases), `loop-commands.ts` (all arg combos, metricless detection, mutual-exclusion reject).
- **Integration tests** (fake pi, mirror goal `__tests__`): `agent_end`→loop-tick dispatch (metric: fake `runMeasure` → improved/plateau/bounded transitions; metricless; HYPOTHESIS parse; continuation-marker dedupe; **heartbeat re-fire for loop**; **mutual exclusion with goal**).
- Reuse goal's test harness (fake `setInterval` / time control) for bounds (time/max) and plateau.
- Coverage targets: every `stopReason` path, every verdict, the measure-failure threshold, mutual exclusion.

## 12. Open questions / risks

- **Heartbeat generalization** touches `goal.ts`'s heartbeat predicate (contained; covered by integration tests).
- **First use of `pi.exec`** in core-task — validated by the audit project precedent (`goal.ts:999`).
- **Measure-failure policy** (≥3 consecutive null → stop) is tunable; revisit after dogfooding.

## 13. References

- `pi-goal-list-loop-audit/extensions/goal-loop-forever.ts` — LoopState pure core (source of the clean-room port).
- `pi-goal-list-loop-audit/extensions/loops/goal.ts:999` — `runMeasure` via `extensionApi.exec`.
- `pi-agent-ext-core-task/src/goal/{goal,backoff,repetition,state,persistence,overlay}.ts` — reuse targets.
- PRs: #814 (heartbeat/backoff/repetition), #818 (isolated auditor), #826 (`/list`).
