# Ticket 03 — colliding command name `loop` breaks slash dispatch via `prompt()`

Status: done (2026-08-23 evening; fix approach 1 — patched dispatch fallback)

## Close-out (2026-08-23 evening)

- **Fix = candidate 1 (patched fallback), at the `getCommand` layer rather
  than `_tryExecuteExtensionCommand`**: new patch
  `bun-apps/s2-agent/src/patches/colliding-command-dispatch.ts` wraps
  `ExtensionRunner.prototype.getCommand` so a plain-name miss retries
  `name:1` (deterministic first registration in extension-load order).
  Choosing `getCommand` over the session method fixes EVERY plain-name lookup
  (prompt() dispatch and any other consumer), needs no private AgentSession
  access (`ExtensionRunner` is exported), and leaves the palette untouched
  (it lists `resolveRegisteredCommands()` directly). Env gate
  `BUN_PI_COLLIDING_COMMAND_DISPATCH=0` to disable; registry entry +
  `PATCH_TABLE` coverage test updated in the same PR.
- **Ownership (map D5)**: plain `/loop` = ext-task's user-facing scheduler
  (first static registration); ultracode's subagent-side /loop stays
  explicitly addressable as `/loop:2`. To keep `/loop dynamic …` from
  silently scheduling a 10m loop whose PROMPT is "dynamic …" under ext-task,
  `parseLoopCommand` now guards the `dynamic`/`off` first words with a
  pointer to `/loop:2` (mirrors ultracode's own bare-dynamic guard).
- **Tests**: `src/patches/colliding-command-dispatch.test.ts` (6 cases:
  fallback resolves loop:1, explicit suffixes still address each, no-collision
  unchanged, misses without a `:1` sibling stay misses, explicit-suffix miss
  does not fall back) + ext-task parser guard cases in
  `src/loop/__tests__/loop-commands.test.ts`.
- **Live smoke re-run (post-fix, scratch project, headless `-p`)**:
  - `/loop status` → dispatched to ext-task's handler; exit 0 in ~28s; NO
    transcript written (zero model turns — pre-fix the same shape produced a
    user-message transcript and a 300s watchdog kill).
  - `/loop:2 dynamic monitor the smoke goal` → dispatched to ultracode's
    handler, loop registered, session-live by design (D7), bounded exit 0,
    zero model turns.
  - `/loop dynamic monitor the smoke goal` (plain + ultracode keyword) →
    ext-task guard message (no mis-schedule), zero model turns, exit 0.
- Gates: s2-agent `CI=true bun run test` 1051 tests / 0 fail + `typecheck`
  exit 0; ext-task `CI=true bun run test` 881 tests / 0 fail + `typecheck`
  exit 0.

## Problem (historical)

## Problem (found by the 2026-08-23 evening `/loop dynamic` live smoke)

Two extensions register a command named `loop`:

- `bun-apps/s2-agent-ext-task/src/loop/loop.ts:54` (the user-facing CC-style
  scheduler)
- `bun-apps/s2-agent-ext-ultracode/src/loop-command.ts:85` (the subagent
  cc-parity-2 t06 `/loop` — known to coexist with ext-task's, memory'd as
  "two machines, coexisting")

The pi SDK's collision handling (`dist/core/extensions/runner.js`,
`resolveRegisteredCommands`) suffixes BOTH registrations — invocation names
become `loop:1` and `loop:2` — so `getCommand("loop")` returns **undefined**.
Consequence: `AgentSession.prompt()`'s slash dispatch
(`_tryExecuteExtensionCommand`, gated on `text.startsWith("/")`) finds no
command, does NOT consume the message, and the literal `/loop …` text is sent
to the MODEL as an ordinary prompt.

Measured 2026-08-23 evening (worktree `loop-dynamic-live-smoke` @ origin/main
9624d9ba, local lm-studio model):

- `-p '/loop dynamic monitor the smoke goal'` → transcript records the raw
  string as a user message to the model; the model ran off exploring (task
  board, cron list, a failed subagent, workflow runs) until the
  print-idle-watchdog bounded the run at 300s (exit 2). The original
  cc-parity-2 spec §9 "BLOCKED (B1)" row for `/loop` dynamic is THIS defect
  plus B1 making it look like a hang.
- Control (faux harness, no collision): an inline extension registering the
  ONLY `probe` command → `prompt("/probe …")` executes the handler with zero
  model turns. Single-name dispatch is fine; only the collision breaks it.
- Tool half is healthy headless: the model called `schedule_wakeup
  {delaySeconds: 5, reason …}` and got the correct no-active-loop text back;
  run completed and exited 0. The defect is exclusively the command-name
  dispatch.

This is the repo's only command-name collision (scanned all
`s2-agent-ext-*` `registerCommand` names 2026-08-23).

## Open verification item

Does the interactive TUI's plain `/loop <args>` submit hit the same
`prompt()` path (broken), or does the palette insert a disambiguated name
(`loop:1`, working)? Severity for interactive users depends on this; the
headless `-p` breakage is confirmed either way.

## Candidate fixes (decide in this ticket)

1. **s2-agent patch (fallback dispatch):** wrap
   `AgentSession.prototype._tryExecuteExtensionCommand` (patches/ already has
   the prototype-wrap pattern) so a missed `getCommand(name)` retries
   `getCommand(name + ":1")` — first registration wins, collision becomes
   disambiguation-only. Small, SDK-version-pinned, and fixes the class (any
   future collision) rather than this pair.
2. **Rename one command:** e.g. ultracode's becomes `/agent-loop` (it is the
   subagent-side machine). Explicit, but breaks the cc-parity-2 t06 surface
   naming and moves the user-facing mismatch around.
3. **Upstream:** file/patch pi-coding-agent so `getCommand(name)` resolves a
   lone suffixed set back to the first occurrence. Cleanest, slowest.

## Done when

- [x] Fix approach chosen (1/2/3) and implemented; a test pins that a prompt
      beginning `/loop ` dispatches to a real command handler (faux-session
      style, or a unit test of the patched dispatch), NOT to the model.
- [x] The `/loop dynamic` live smoke re-run PASSes end-to-end headless:
      `/loop status` and `/loop:2 dynamic <prompt>` both dispatched with ZERO
      model turns and bounded exits (post-fix, measured above); plain
      `/loop dynamic` hits the guard pointer instead of mis-scheduling.
- [x] cc-parity-2 spec §9 `/loop` row updated with the final outcome; this
      ticket linked.

## Bounds

- Do not touch the runner's suffix behavior itself (upstream-owned); a patch
  must live in `bun-apps/s2-agent/src/patches/` with the existing
  wrap + test pattern.
- Watchdog stays as-is — it correctly bounded the runaway exploration
  dispatch; that is its job.
