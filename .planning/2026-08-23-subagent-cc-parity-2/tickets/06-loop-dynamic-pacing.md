# Ticket 06 — /loop + schedule_wakeup dynamic self-pacing

Status: open · Phase 3 (ultracode-only; independent)

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
