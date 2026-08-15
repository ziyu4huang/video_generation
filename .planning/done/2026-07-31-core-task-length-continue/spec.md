> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Spec — core-task length-continue (faithful verbatim baseline)

- **Date:** 2026-07-31
- **Status:** Done (shipped #966)
- **Effort dir:** `.planning/2026-07-31-core-task-length-continue/`
- **Origin:** wayfinder "go next" (no map needed — single small gap); strategy decided in brainstorming
- **Precedent:** mirrors the Reviewer faithful-baseline decision (PR #962)

## 1. Goal

Port GLA's `length-continue` into `pi-agent-ext-core-task` as a faithful
verbatim baseline: when ONE assistant response is truncated by the model's
provider-side per-response output cap (`stopReason === "length"`), pi ends the
turn and idles — a dead stop on unattended rigs. The Reviewer-style port adds a
pure tracker module + a thin agent_end wiring that re-triggers the agent with
"continue exactly where you stopped" guidance, skipping all turn bookkeeping for
the half-response so the truncated turn is neither counted, nudged, nor
mis-measured.

## 2. Background / why

- core-task's `agent_end` handler (`src/goal/goal.ts:647`) handles `stopReason`
  `"aborted"` / `"error"` (line 665) but has **no `"length"` handling** — a
  truncated turn runs the full bookkeeping (liveness stamp, incrementGoal,
  usage, toollessStreak/nudge, repetition, continuation) and then idles.
  Confirmed gap (grep found zero `"length"` branches).
- GLA folds this in at `extensions/length-continue.ts` (72 lines, pure) wired at
  the top of `extensions/loops/goal.ts` agent_end (line ~5794). Its design
  principle: *"a truncated turn is not a completed turn (no telemetry), not a
  stall (no no-tool nudge), and must not run the loop measure or the normal goal
  continuation on half a response."*
- core-task has the exact matching message-injection API: `pi.sendUserMessage`
  (`src/goal/goal.ts:1118-1119`, used by `sendContinuationPrompt`). No new
  mechanism is needed — the port is a clean transplant.

## 3. Non-goals

- Adapting to core-task's `continuationPending` / `sendContinuationPrompt`
  infrastructure (Approach B, rejected — couples to the continuation guard,
  risks double-trigger; verbatim is cleaner).
- `/loop`-specific truncation tuning beyond what the top-of-handler placement
  naturally covers (it does cover `/loop` — see §5 — but no loop-metric surgery).
- The other GLA gaps (quota-retry, settings-menu, model-picker, auditor-delta).
- Persisting truncation-streak state across sessions (GLA resets on reload; we
  reset on session_start — a fresh runtime starts clean).
- `goStaleTerminal`-style external notify wiring beyond a try/catch + `ui.notify`
  (core-task has no `goStaleTerminal`; we replicate its *intent* — don't crash
  the handler on a stale API handle — with a plain try/catch).

## 4. The pure module — `src/goal/length-continue.ts` (verbatim)

Verbatim port of GLA's 72-line `extensions/length-continue.ts`. **Zero
`@earendil-works/*` imports** (pure-module + injected-side-effects invariant,
same as `reviewer.ts`). Exports:

- `LENGTH_CONTINUE_MAX = 3` — consecutive-truncation cap.
- `LENGTH_CONTINUE_TEXT` — the continue guidance (3 sentences joined). Generic
  wording, no command references → ports verbatim.
- `LengthContinueTick` — `{ fire: boolean; giveUpNow: boolean; consecutive: number }`.
- `makeLengthContinueTracker(max = LENGTH_CONTINUE_MAX)` — the tracker factory
  (closure over `consecutive`, `gaveUp`): `tick(stopped)` resets on
  `!stopped`, increments + returns `fire:true` while `consecutive <= max`,
  flips to `fire:false, giveUpNow:true` (once) when exceeded.
- `tickLengthContinue(stopped)` — module-singleton tick (session-scoped streak).
- `resetLengthContinue()` — resets the singleton (called on session_start).

The factory + singleton shape is kept verbatim so the existing GLA unit tests
translate directly.

## 5. Wiring — `src/goal/goal.ts` `agent_end` handler, TOP

Insert at the **very top** of the `agent_end` handler (currently `goal.ts:647`),
**before** the `isLoopActive()` dispatch (line 650) and the no-active-goal bail
(line 654). This ordering is load-bearing:

- Before the loop dispatch → a truncated turn during an active `/loop` also
  auto-continues (the loop iteration is half a response).
- Before the no-goal bail → a truncated turn in a **plain session (no goal)**
  also auto-continues — faithful to GLA ("works with no goal active").

Sequence:

1. Hoist `findFinalAssistantMessage(event.messages ?? [])` to the top (it is
   currently called at line 660; the later site reuses the hoisted binding — no
   double call).
2. `const lc = tickLengthContinue(finalAssistant?.stopReason === "length");`
3. `if (lc.giveUpNow) ctx.ui.notify(GIVE_UP_TEXT, "warning");` where
   `GIVE_UP_TEXT` is a core-task-style rewrite of GLA's (drop the `glla:`
   prefix and the `/glla` references — apply the Reviewer M2 lesson: never
   reference commands that don't exist in core-task). Candidate:
   `Response hit the output-token cap ${LENGTH_CONTINUE_MAX}× in a row — stepping aside from auto-continue. Ask the model to split the work into smaller pieces.`
   (GLA also calls `notifyExternal(...)` here for an out-of-band channel;
   core-task has no `notifyExternal` equivalent → **dropped** for baseline,
   see §12 follow-ups.)
4. `if (finalAssistant?.stopReason === "length") {`
   `  if (lc.fire && !hasPendingMessages(ctx)) sendLengthContinue(pi, ctx, lc.consecutive);`
   `  return;`  ← skips ALL turn bookkeeping (liveness stamp, incrementGoal,
   usage, recovery, budget, persist, toollessStreak/nudge, repetition,
   continuation).
   `}`
5. (Existing bookkeeping proceeds unchanged for non-truncated turns.)

### `sendLengthContinue(pi, ctx, consecutive)` helper (thin, local to goal.ts)

Maps GLA's `sendLengthContinue` (`extensions/loops/goal.ts:1059`) onto
core-task's APIs — faithful in *intent*, core-task-native in *mechanism* (the
pure module is the verbatim part; the wiring maps GLA's `extensionApi.*` /
`appendLedger` / `goStaleTerminal` to core-task's `pi.sendUserMessage` /
`appendEntry` / try-catch, exactly as the Reviewer mapped `createGoal` etc.):

- **Send:** `pi.sendUserMessage(LENGTH_CONTINUE_TEXT, { deliverAs: "followUp" })`
  — the text is constant (LENGTH_CONTINUE_TEXT); `{ deliverAs: "followUp" }`
  maps GLA's `deliverAs`. GLA's `triggerTurn: true` is implied by `sendUserMessage`
  (it always starts a turn). GLA wraps the text in a structured
  `sendMessage({customType: GOAL_EVENT_ENTRY, ...})`; core-task records that
  observability separately (next bullet), and uses plain `sendUserMessage`.
- **Fire-path notify:** `ctx.ui.notify(\`Response hit the output-token cap — auto-continuing (${consecutive}/${LENGTH_CONTINUE_MAX})\`, "warning")`
  — GLA's informative notify on every successful fire (distinct from the
  give-up notify in §5 step 3). `consecutive` is what it's for.
- **Ledger (observability):** on success `appendEntry("length_continue_sent", { consecutive })`;
  on failure `appendEntry("length_continue_send_failed", { consecutive, error })`.
  Uses the same core-task persistence API the Reviewer ledger uses
  (`src/goal/persistence.ts` `appendEntry`).
- **Stale-handle safety:** wrap the whole body in `try { ... } catch (err) { /*
  ledger the failure (above); do NOT rethrow */ }` — replicates GLA's
  goStaleTerminal *intent* (a stale API handle must not crash the `agent_end`
  handler) with the lightest core-task mechanism. core-task has no
  `goStaleTerminal`/`isStaleApiError`; a plain catch is the faithful-equivalent.

## 6. Reset hook — `session_start` handler (`goal.ts:534`)

Call `resetLengthContinue()` inside the `session_start` handler, alongside the
existing `clearContinuationTracking()` / `clearGoalRecovery()` resets. GLA calls
it on runtime reload; core-task's `session_start` is the equivalent
fresh-runtime point. A fresh session starts with a zero truncation streak.

## 7. Guards (verbatim from the module — no extra work)

- **consecutive cap:** after `LENGTH_CONTINUE_MAX` (3) back-to-back truncations,
  give up exactly once (`giveUpNow`), then stop firing — avoids a truncation
  ping-pong burning quota.
- **pending-message skip:** `!hasPendingMessages(ctx)` before sending (a queued
  message triggers a turn anyway — sending again would double-fire).
- **normal-turn reset:** any turn with `stopReason !== "length"` resets the
  consecutive counter to 0 (the tracker's `!stopped` branch).

## 8. Compose with Reviewer PR #962

- length-continue edits the `agent_end` handler; Reviewer edits the
  `goal_complete` handler. **Different handlers, different lines → zero
  conflict.**
- Implementation branches off `main` (clean `goal.ts`, no Reviewer). When both
  PRs land, the edits compose trivially. No special merge ordering required.

## 9. Testing

### 9.1 Pure-module unit tests — `src/goal/__tests__/length-continue.test.ts`
Translate GLA's tracker tests directly:
- normal turn (`stopped=false`) → `fire:false`, resets streak to 0.
- truncate (`stopped=true`) → `fire:true`, `consecutive` increments.
- 3× truncate → 4th returns `fire:false, giveUpNow:true` (exactly once);
  subsequent truncates return `fire:false, giveUpNow:false`.
- a normal turn after the cap resets `gaveUp`, so a later truncate fires again.
- `resetLengthContinue()` zeroes the singleton.

### 9.2 Wiring tests — add to `hardening-loop.test.ts` (or new
`length-continue-wiring.test.ts`), using the existing mock-ctx harness:
- **fire path:** drive `agent_end` with a final assistant `stopReason:"length"`
  → assert `pi.sendUserMessage` called once with `LENGTH_CONTINUE_TEXT` +
  `{ deliverAs: "followUp" }`; assert the fire-path `ui.notify`
  (`auto-continuing (N/${LENGTH_CONTINUE_MAX})`) fired; assert the
  `length_continue_sent` ledger entry appended; assert the normal bookkeeping
  is **skipped** (no `incrementGoal`, no nudge count bump, no repetition push,
  no continuation scheduled).
- **plain-session path:** same with no active goal → still fires (before the
  no-goal bail).
- **non-length turn:** `stopReason:"end_turn"` (or undefined) → `sendUserMessage`
  NOT called; normal bookkeeping runs.
- **pending-messages skip:** `stopReason:"length"` but `hasPendingMessages→true`
  → NOT fired (the queued message owns the next turn).
- **give-up path:** 4× `stopReason:"length"` → 4th fires the `ui.notify`
  give-up warning once, does not call `sendUserMessage`.
- **reset:** `session_start` between truncations → streak reset (next truncate
  fires again).
- **`/loop` coverage (optional):** an active loop + `stopReason:"length"` →
  fires before `runLoopTick` (the loop measure is skipped for the half-turn).

## 10. Acceptance criteria

1. `src/goal/length-continue.ts` exists, is pure (zero `@earendil-works/*`
   imports), and exports the §4 API verbatim-shape.
2. A truncated turn (`stopReason:"length"`) re-triggers the agent with
   `LENGTH_CONTINUE_TEXT` and skips all `agent_end` bookkeeping — for goal-loop,
   `/loop`, and plain-session contexts.
3. 3 consecutive truncations give up once (notify) and stop firing; any normal
   turn resets the streak; `session_start` resets the singleton.
4. The give-up notification references no non-existent commands (no `/glla`).
5. core-task suite green (existing 577 + new tests); `bunx tsc --noEmit`
   exit 0 (per-package AND cross-package `pi-agent`).
6. Composes with PR #962 without conflict (branch off main).

## 11. Decisions

- **D1 — Strategy: faithful verbatim baseline** (Approach A). Rationale: the
  module is pure + tiny, `pi.sendUserMessage` is the exact matching API, and it
  preserves the pure-module + injected-side-effects invariant established by
  reviewer.ts. (Rejected: B adapt-to-continuation-infra — double-trigger risk;
  C inline — loses tracker testability.)
- **D2 — Placement: very top of agent_end** (before loop dispatch + no-goal
  bail). Rationale: faithful to GLA; covers `/loop` and plain sessions, not just
  the goal loop.
- **D3 — Give-up text: rewritten core-task style** (drop `/glla`). Rationale:
  the Reviewer M2 lesson — never surface references to commands that don't exist
  in core-task.
- **D4 — Stale-handle safety: try/catch + ledger**, not a `goStaleTerminal`
  port. Rationale: core-task has no `goStaleTerminal`/`isStaleApiError`; we
  replicate the *intent* (don't crash the handler on a stale API handle) with
  the lightest mechanism, and ledger the failure for observability.
- **D5 — Wiring maps GLA APIs to core-task APIs** (the pure module is the
  verbatim part). `extensionApi.sendMessage({customType,content,display},
  {triggerTurn,deliverAs})` → `pi.sendUserMessage(text,{deliverAs:"followUp"})`
  + separate `appendEntry`; `appendLedger` → `appendEntry`; `goStaleTerminal`
  → try/catch; `notifyExternal` → dropped (no equivalent). Rationale: this is
  exactly the Reviewer's faithful-baseline mapping (pure module verbatim,
  side-effect APIs localized to the wiring).

## 12. Follow-ups (deferred)

- Evaluate whether `/loop` (loop.ts) wants its own length-continue awareness
  beyond the top-of-goal.ts-agent_end coverage (e.g., loop-metric accounting for
  a truncated iteration).
- quota-retry as the next GLA gap (the other high-value small clean port).

### 12.1 Post-implementation follow-up (from the SDD final review, 2026-07-31)

The baseline shipped merge-ready (2 commits, 547/0, tsc clean per-package +
cross-package). One non-blocking item the final review surfaced:

- **(optional hardening, NOT merge-blocking) Heartbeat race on the giveUp terminal path**
  — the early `return` in `goal.ts`'s `agent_end` skips the `lastActivityAt`
  liveness stamp for every truncated turn. On the *giveUp* terminal case (4th+
  truncation, when no continue message is sent), a heartbeat tick landing in an
  idle window could fire one spurious `sendContinuationPrompt`. It is
  **self-limiting** (the spurious prompt sets `continuationPending`, which
  suppresses further refires until a normal turn resets it) and requires a
  toolless truncation chain spanning >120s (tool-bearing truncated turns still
  stamp via `tool_execution_end`), bounded by `LENGTH_CONTINUE_MAX=3`. Optional
  fix: stamp `goalState.lastActivityAt = Date.now()` on the giveUp branch (or
  inside `sendLengthContinue`) to fully close the race. Consistent with the
  faithful GLA baseline (GLA's own handler structure has the same shape).
