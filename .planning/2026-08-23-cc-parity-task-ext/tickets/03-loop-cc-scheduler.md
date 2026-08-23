---
ticket: 03-loop-cc-scheduler
effort: cc-parity-task-ext
type: task
status: closed
created: 2026-08-23
last: 2026-08-23
---
# 03 — /loop: CC-style recurring scheduler replaces the process loop

> Spec §4.3, decisions D3/D6.

## Goal

`/loop <interval> <prompt>` re-enqueues a prompt on a timer, firing only while idle —
CC semantics — with the process-improvement machinery and goal coupling deleted.

## What to build

1. Probe: can an extension invoke a registered slash command programmatically? If
   yes, accept `/loop <interval> /<command>` targets; otherwise prompt-only (Fog of
   war condition resolved here).
2. New `src/loop/`: `parseLoopCommand` (`[interval] <prompt...>`, default 10m,
   `90s|5m|1h` via existing `parseDuration`; `stop`; `status`), scheduler (timer chain,
   idle-gated fire via `isIdle()`, postpone-on-busy re-arm), session persistence
   (persist on start, restore on session_start, clear on stop), simplified overlay
   (interval/target/next-fire/iteration).
3. Delete: `loop-metric.ts`, plateau/anti-repetition state, continuation-marker
   machinery, `registerLoop`'s `before_agent_start` hook; goal coupling at
   `goal/hooks.ts:254-255`, `goal/lifecycle.ts:54`, `goal/status.ts:116,129`
   (heartbeat supervision returns to goal-only).
4. Rewrite `src/loop/__tests__/` for scheduler semantics; update goal tests that
   referenced loop-active branches; `extensions/task.ts` wiring updated.

## Acceptance

- `/loop 5m check the deploy` fires the prompt only while idle; a busy tick
  postpones, it does not drop.
- `/loop stop` cancels and clears persistence; restart with an active loop restores
  it (session persistence round-trip).
- `grep -rn "measureCmd\|plateau\|HYPOTHESIS" src/loop src/goal` clean of loop-side
  hits (goal's own usage unaffected).
- No compat layer: `/loop start "…" measure=…` produces a usage message naming the
  new syntax.

## Gate

`( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )`

## Result

**closed 2026-08-23** — commits d8774317 (parser/scheduler/persistence) + 8072b0fb (registration rewrite + goal decoupling) + follow-up wiring.

- `parseInterval` s/m/h/d with seconds rounding UP to whole minutes; `parseLoopCommand` `[interval] <prompt>` default 10m; old `start "…" measure=…` syntax returns a usage pointer naming the new surface.
- `LoopScheduler`: injectable-clock timer chain, idle-gated fire, postpone-on-busy (60s recheck, never drops), 7-day max-age fires once then self-stops. Fully synchronous `tick()` (fire is dispatched, not awaited) — awaiting a slow send used to delay re-arming past the test horizon.
- Slash-command targets: **supported**. Probe finding 2026-08-23 (agent-session.js:797-805): `prompt()` routes "/"-prefixed text through the extension-command registry ONLY when `expandPromptTemplates` is true; `sendUserMessage` defaults it false (public option per agent-session.d.ts:410-413). The fire hook passes `{ expandPromptTemplates: true }` for slash targets — `/loop 1d /daily-summary` executes the command, not a literal message.
- Goal decoupled at all four sites (hooks agent_end dispatch, lifecycle XOR gate, heartbeat shouldRun + refire branch); heartbeat supervises goals only; /goal and /loop run concurrently (CC parity — old XOR gate deleted).
- Deletions: loop-state.ts, loop-metric.ts, continuation-marker machinery, before_agent_start marker hook, setLoopRenderSid/__resetLoopState wiring (loop no longer keys per-session buckets — one scheduler per process).
- Gate: tsc clean; 865 pass / 0 fail (61 files).

Plan-errata fixed inline: 90s→120_000 under the round-up rule (plan's literal contradicted itself), primitive-string instanceof check, USAGE ellipsis vs toContain, scheduler harness now advances to next timer deadline, fake session entries carry `type: "custom"`.
