# Ticket 06 — /loop + schedule_wakeup dynamic self-pacing

Status: done (2026-08-23) · Phase 3 (ultracode-only; independent)

## Close-out (2026-08-23)

- **S5 fog CLOSED first, as the approach prescribed**: a REAL
  `createAgentSession` over the pi faux transport with turn one held open
  mid-stream (`tests/wakeup-interleave.test.ts`) pins the fire-seam contract:
  `sendUserMessage(prompt, {deliverAs: "followUp"})` during streaming does NOT
  throw, queues exactly one followUp (`pendingMessageCount === 1`), the
  streaming turn completes undisturbed, and the queue drains into EXACTLY one
  new turn (faux `callCount === 2` — no runaway). Idle-session fire verified
  too (direct turn, nothing queued).
- **Built per approach**: `src/wakeup-registry.ts` (in-memory, one pending per
  loop id, last-fired snapshot so the dynamic tool re-arms with the ORIGINAL
  prompt + running fireCount past a fire, fire cap 50 with pre-fire auto-stop),
  `src/wakeup-tools.ts` (`schedule_wakeup`: clamp 60–3600 LOUD not rejecting,
  required reason, stop, cache-window-aware pacing guidance in the
  description), `src/loop-command.ts` (`/loop 30s|5m|1h <prompt>` — unit
  REQUIRED so a leading-digit prompt can't be misparsed as an interval —
  default 10m, `dynamic`, `off`), sibling `startWakeupLoop` beside the cron
  loop in `extensions/ultracode.ts` (same stop/restart discipline, cleared at
  `session_shutdown`, `<wakeup>` display messages for loop starts/stops).
- One design deviation from the ticket text, recorded in
  `runWakeupTick`'s docstring: a dynamic loop that never re-arms ends
  SILENTLY — the tool call happens inside the fired turn, AFTER `fire()`
  returns, so a tick cannot observe "did not schedule". The only `ended` event
  is the fire cap (pre-fire check). Bare `/loop dynamic` without a prompt is a
  usage error (was silently a fixed loop whose prompt was the word "dynamic").
- Gates: ext-ultracode `CI=true bun run test` 1169 pass (21 new across 4
  files) + `check` + `typecheck` exit 0; ext-tool-gate `bun run test` 434
  pass + `typecheck` exit 0 (the workflow-family order pin now 14 names,
  `schedule_wakeup` after `cron_delete`). spec.md §2 `/loop` row updated
  gap→aligned in this PR.

## Scope

CC `/loop` + dynamic mode: a `/loop [interval|dynamic] <prompt>` command and a
`schedule_wakeup` tool the model calls to self-pace (delaySeconds clamped
60–3600, required reason, optional stop), re-firing the loop prompt into the
session each wake. Per map D7: wakeups are in-memory and session-live — they
do NOT enter `cron-store.ts`'s durable + leased space; no daemon.

## Approach

1. New `src/wakeup-registry.ts` (in-memory `{id, dueAt, prompt, reason}[]`;
   max 1 pending wakeup per loop id; cleared on `session_shutdown`).
2. New `src/wakeup-tools.ts`: `createScheduleWakeupTool` factory (pattern:
   `cron-tools.ts`). Params: `delaySeconds` (clamp 60–3600 with a loud message
   when clamped — mirrors CC), `reason` (required), `stop` (optional boolean:
   cancels the loop). Description embeds cache-window-aware pacing guidance
   (stay inside the prompt-cache window; longer delays when waiting on
   external state; never poll harness-tracked work).
3. Loop tick: a SIBLING `startWakeupLoop({registry, fire})` beside
   `startCronSchedulerLoop` in `extensions/ultracode.ts` (:289) with the same
   tickMs injectability — do not touch cron-loop's tested tick contract.
4. Fire seam: `pi.sendUserMessage(prompt, {deliverAs: "followUp"})` — always
   triggers a turn, queues while streaming (`extensions/types.d.ts:302`). The
   fired prompt is the ORIGINAL `/loop` prompt plus a footer with the last
   `reason` and an instruction to continue + schedule the next wakeup, or
   stop.
5. `/loop` command (new `src/loop-command.ts`, modeled on `effort-command.ts`):
   `/loop 5m <prompt>` fixed cadence (auto-rescheduling wakeup with fixed
   delay — one mechanism, two paces), `/loop dynamic <prompt>` model-driven
   via the tool, `/loop off` cancels. Default 10m per CC.
6. Registration: the tool joins the workflow gate family — check the pinned
   registration-order tests (place after `cron_delete`) and update them.

## Files

- New: `bun-apps/s2-agent-ext-ultracode/src/wakeup-registry.ts`,
  `src/wakeup-tools.ts`, `src/loop-command.ts`
- `extensions/ultracode.ts`, `src/index.ts` exports if needed
- spec.md §2 /loop row — same PR

## Risks

- `sendUserMessage` during an active streaming turn — followUp queues, but the
  interleaving must be tested end-to-end with a fake session before trusting
  it live (map fog).
- Runaway loops — hard cap on fires per session (default 50), then auto-stop
  with a notification.
- TUI observability — a `<wakeup>` display message via `pi.sendMessage`
  customType alongside the user message.

## Verification

- New `tests/wakeup-registry.test.ts` (clamp, single-pending, stop, cap),
  `tests/wakeup-tools.test.ts` (factory schema/returns),
  `tests/loop-command.test.ts` (parsing, fixed vs dynamic vs off); a tick test
  with fake `fire` mirroring `cron-loop.test.ts`'s injectable tickMs.
- Full gates in s2-agent-ext-ultracode; tool-gate family order pin updated.
