# Ticket 01 — diagnose & bound the headless pre-send hang (B1)

Status: bounded (2026-08-23 evening session); root-cause chase narrowed to
`main()` never resolving — see "Where it stands".

## Problem (as originally filed)

Headless `./s2-agent.sh --model deepseek/deepseek-v4-flash --no-session --mode
json -p "<prompt>"` appeared to hang BEFORE the first model request: zero JSON
events on stdout, 0% CPU, zero TCP connections, main thread parked in
`kevent64`.

## Diagnosis (2026-08-23, two sessions)

**The "pre-send hang" was a measurement artifact — B1 and B3 are the SAME
defect.** Running the identical invocation under a pty (`script -q`) showed
the "hung" run completing its FULL event chain (user → assistant deltas →
`agent_settled`) within ~1s: the events were sitting in bun's fully-buffered
file-redirected stdout. The real defect is the process **never exiting after
the work completes** (B3), which made the buffered file read 0 bytes.

Measured facts:

- Healthy path: `main()` resolves after the one-shot; instrumentation printed
  `active: []` (empty `process.getActiveResourcesInfo()`) and the process
  exited naturally. Exit times 3–5s across 8+ clean trials.
- Hang path: `main()` NEVER resolves — post-`main` diagnostic code appended to
  cli.ts never executed while the process sat alive at 60s.
- The prompt-shape correlation (angle brackets 4/4 etc.) was **noise** from
  ~10 samples: after the contention window passed, the exact same "hang"
  prompts passed 8/8, and a 5-trivial-prompt sweep hung during a later window.
- Time-window correlate: hang windows coincided with **concurrent deploy /
  verify-deploy-e2e / probe s2-agent processes** (same `~/.pi` state dir,
  e.g. 18:27–18:28 `deploy-cli.ts` + 0.2.9 sh-probe instances). Causation
  unproven — fog.
- What in `main()`'s await chain stalls remains unidentified (fog); bare mode
  (`--no-extensions --no-skills`) reproduces, so it is in the SDK core path,
  not extensions/skills/hermes.

## Bound shipped (this ticket's remedy arm)

`bun-apps/s2-agent/src/print-idle-watchdog.ts` + wiring in `src/cli.ts`:

- Print mode (`-p`/`--print`) arms an idle watchdog BEFORE `main()`: every
  `process.stdout.write` stamps activity; total stdout silence past
  `S2_PRINT_IDLE_EXIT_MS` (default 300s, `0` disables) dumps the active
  event-loop resources to stderr and exits 2 — any recurrence becomes
  captured evidence instead of a silent forever-hang.
- After `main()` resolves, `finishPrintMode` dumps lingering resources and
  exits 0 after a 2s flush grace — closes shape (a) (settled + lingering
  handle).
- Unit tests: `print-idle-watchdog.test.ts` (10 cases: env parsing, argv
  detection, fire/reset/disable, post-main grace). Live-verified: healthy
  runs complete and exit in 3–5s with no diagnostic.

## Done when

- [x] Root cause named OR bounded by a deadline with a diagnostic — bounded
      (idle watchdog + post-main grace); root cause narrowed to "`main()`
      never resolves during contention windows" (file:line still fog).
- [x] Headless `-p` either never hits the await, or aborts with a diagnostic
      within the deadline.
- [ ] The oneshot-smoke CI gate gains a prompt shape that would have caught
      this — NOT DONE; now reframed: the gate spawns `-p` probes with output
      to files and a wall-clock cap, so it already bounds this class
      externally; the remaining value is a non-trivial prompt in the probe.

## Where it stands

The watchdog converts any recurrence into a stderr diagnostic naming the
event-loop holders. The next recurrence should be read from
`[print-idle-watchdog]` stderr lines before resuming the root-cause chase.
